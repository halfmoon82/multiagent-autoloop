package cool.autoloop.console.notify;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * 通知渠道、常驻通知、角标与去重状态的集中持有者。
 * 纯 AndroidX/Capacitor 依赖，不引入第三方推送或角标库。
 */
final class NotifyChannels {
  static final String CHANNEL_ONLINE = "autoloop_online";
  static final String CHANNEL_TODO = "autoloop_todo";
  static final String CHANNEL_NODE_DONE = "autoloop_node_done";
  static final String PREFS = "autoloop_notify";
  static final int ONLINE_ID = 1001;
  static final int REBIND_ID = 1002;

  // kind:id:revision 去重：同一事项只通知一次；进程内集合为一级，持久化 prefs 为二级。
  private static final Set<String> NOTIFIED = new HashSet<>();

  private NotifyChannels() {}

  static NotificationManager manager(Context ctx) {
    return (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
  }

  static void createAll(Context ctx) {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = manager(ctx);
    create(nm, CHANNEL_ONLINE, "NoMoTo 在线", NotificationManager.IMPORTANCE_LOW);
    create(nm, CHANNEL_TODO, "待我决策", NotificationManager.IMPORTANCE_HIGH);
    create(nm, CHANNEL_NODE_DONE, "节点完成", NotificationManager.IMPORTANCE_DEFAULT);
  }

  private static void create(NotificationManager nm, String id, String name, int importance) {
    if (nm.getNotificationChannel(id) == null) {
      nm.createNotificationChannel(new NotificationChannel(id, name, importance));
    }
  }

  /** dataSync 前台服务的常驻通知：标题固定为「NoMoTo 在线」，number 同步角标。 */
  static Notification ongoing(Context ctx, int badge) {
    NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ONLINE)
        .setSmallIcon(android.R.drawable.stat_sys_upload_done)
        .setContentTitle("NoMoTo 在线")
        .setContentText("常驻保活中，待办与节点完成会通知您")
        .setOngoing(true)
        .setNumber(Math.max(0, badge))
        .setCategory(NotificationCompat.CATEGORY_SERVICE);
    if (Build.VERSION.SDK_INT >= 26) b.setChannelId(CHANNEL_ONLINE);
    return b.build();
  }

  /** 设备授权失效（401）：停服务后由调用方发出「请重新绑定」通知。 */
  static Notification rebindNotification(Context ctx) {
    NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_TODO)
        .setSmallIcon(android.R.drawable.stat_notify_error)
        .setContentTitle("请重新绑定")
        .setContentText("设备授权已失效，请打开 App 重新绑定后继续接收通知")
        .setAutoCancel(true);
    return b.build();
  }

  /** 声明一个去重键；返回 false 表示同一事项已通知过。 */
  static synchronized boolean claim(String key) {
    if (key == null || key.isEmpty()) return false;
    return NOTIFIED.add(key);
  }

  static void setBadge(Context ctx, int count) {
    int safe = Math.max(0, count);
    SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    sp.edit().putInt("badge", safe).apply();
    // 部分桌面从常驻通知的 number 读角标：刷新常驻通知以同步。
    NotificationManager nm = manager(ctx);
    if (nm != null) nm.notify(ONLINE_ID, ongoing(ctx, safe));
  }

  static int getBadge(Context ctx) {
    return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("badge", 0);
  }

  /** 由 JS descriptor 构建并发布一条系统通知；待办带选项按钮 + 文字输入的 RemoteInput 直复。 */
  static void postDescriptor(Context ctx, JSONObject descriptor, String kind) {
    boolean todo = CHANNEL_TODO.equals(kind);
    String channel = todo ? CHANNEL_TODO : CHANNEL_NODE_DONE;
    String id = descriptor.optString("id", "notify");

    NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channel)
        .setSmallIcon(todo ? android.R.drawable.stat_notify_chat : android.R.drawable.stat_sys_download_done)
        .setContentTitle(descriptor.optString("title", "Autoloop 通知"))
        .setContentText(descriptor.optString("body", ""))
        .setAutoCancel(!todo); // 节点完成点开即撤销；待办保留到直复处理

    if (todo) addReplyActions(ctx, b, descriptor);

    NotificationManager nm = manager(ctx);
    if (nm != null) nm.notify(id.hashCode(), b.build());
  }

  /** 直复动作：每个选项一个按钮，外加一个文字输入；都带 RemoteInput 回写答案路由。 */
  private static void addReplyActions(Context ctx, NotificationCompat.Builder builder, JSONObject descriptor) {
    String cardId = descriptor.optString("id", "").replaceFirst("^todo:", "");
    JSONObject reply = descriptor.optJSONObject("reply");
    JSONArray choices = reply != null ? reply.optJSONArray("choices") : null;
    String[] choiceLabels = new String[choices == null ? 0 : choices.length()];

    if (choices != null) {
      for (int i = 0; i < choices.length(); i++) {
        JSONObject choice = choices.optJSONObject(i);
        String label = choice != null ? choice.optString("label", choice.optString("id", "")) : String.valueOf(choices.opt(i));
        choiceLabels[i] = label;
        if (label.isEmpty()) continue;
        Intent choiceIntent = replyIntent(ctx, cardId);
        choiceIntent.putExtra(ForegroundService.EXTRA_REPLY_TEXT, label);
        int requestCode = cardId.hashCode() + i + 1;
        builder.addAction(new NotificationCompat.Action.Builder(
            android.R.drawable.ic_menu_send, label,
            android.app.PendingIntent.getBroadcast(ctx, requestCode, choiceIntent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE)).build());
      }
    }

    // 文字回复：RemoteInput 作为结果键，选项作为建议回复一并下发（选项按钮 + 文字）。
    RemoteInput remoteInput = new RemoteInput.Builder(ForegroundService.KEY_TEXT_REPLY)
        .setLabel("输入回复")
        .setChoices(choiceLabels)
        .build();
    Intent textIntent = replyIntent(ctx, cardId);
    int textCode = cardId.hashCode() + 97;
    android.app.PendingIntent textPi = android.app.PendingIntent.getBroadcast(ctx, textCode, textIntent,
        android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
    builder.addAction(new NotificationCompat.Action.Builder(
        android.R.drawable.ic_menu_edit, "文字回复", textPi).addRemoteInput(remoteInput).build());
  }

  private static Intent replyIntent(Context ctx, String cardId) {
    return new Intent(ctx, NotifyReplyReceiver.class)
        .setAction(ForegroundService.ACTION_REPLY)
        .putExtra(ForegroundService.EXTRA_CARD_ID, cardId);
  }

  /** 直复失败：保留同一条通知并改为「直复失败，请重试」，不撤销、不丢草稿入口。 */
  static void postReplyFailure(Context ctx, String cardId) {
    NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_TODO)
        .setSmallIcon(android.R.drawable.stat_notify_error)
        .setContentTitle("直复失败，请重试")
        .setContentText("回复未送达，请重新选择或输入")
        .setAutoCancel(false);
    NotificationManager nm = manager(ctx);
    if (nm != null) nm.notify(cardId.hashCode(), b.build());
  }
}
