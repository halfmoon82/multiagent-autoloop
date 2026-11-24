package cool.autoloop.console.notify;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * window.AutoloopNotify 的原生实现。JS 侧传 JSON 字符串，@JavascriptInterface 方法
 * 切回主线程执行 start/stop/notify/cancel/onReply/setBadge；onReply 注册 JS 回调名，
 * 直复到达时由桥回拨该回调，供 H5 更新本地状态。
 */
final class AutoloopNotifyBridge {
  private final AutoLoopNotifications plugin;
  private final Handler main = new Handler(Looper.getMainLooper());

  AutoloopNotifyBridge(AutoLoopNotifications plugin) {
    this.plugin = plugin;
  }

  /** start(optionsJson)：启动 dataSync 前台服务，options 含 deviceToken/intervalMs/baseUrl。 */
  @JavascriptInterface
  public void start(String options) {
    main.post(() -> {
      Intent intent = new Intent(plugin.getContext(), ForegroundService.class);
      try {
        JSONObject optionsJson = new JSONObject(options);
        intent.putExtra(ForegroundService.EXTRA_DEVICE_TOKEN,
            optionsJson.optString("deviceToken", ""));
        intent.putExtra(ForegroundService.EXTRA_INTERVAL_MS,
            optionsJson.optLong("intervalMs", 15_000L));
        intent.putExtra(ForegroundService.EXTRA_BASE_URL,
            optionsJson.optString("baseUrl", ""));
      } catch (Exception ignored) { /* 参数缺失时用服务内已持久化的配置 */ }
      androidx.core.content.ContextCompat.startForegroundService(plugin.getContext(), intent);
    });
  }

  /** stop()：停止前台服务并移除常驻通知。 */
  @JavascriptInterface
  public void stop() {
    main.post(() -> plugin.getContext().stopService(
        new Intent(plugin.getContext(), ForegroundService.class)));
  }

  /** notify(descriptorJson)：按 H5 descriptor 发一条系统通知（待办或节点完成）。 */
  @JavascriptInterface
  public void notify(String descriptor) {
    main.post(() -> {
      try {
        JSONObject data = new JSONObject(descriptor);
        String kind = data.optString("kind", NotifyChannels.CHANNEL_TODO);
        String channel = NotifyChannels.CHANNEL_TODO.equals(kind)
            ? NotifyChannels.CHANNEL_TODO : NotifyChannels.CHANNEL_NODE_DONE;
        String key = "notified:" + data.optString("key", data.optString("id", ""));
        if (!NotifyChannels.claim(key)) return; // 同一事项不重复通知
        NotifyChannels.postDescriptor(plugin.getContext(), data, channel);
      } catch (Exception ignored) { /* descriptor 非法则不发通知 */ }
    });
  }

  /** cancel(id)：按 id 撤销一条系统通知。 */
  @JavascriptInterface
  public void cancel(String id) {
    if (id == null) return;
    main.post(() -> {
      NotificationManagerHolder.cancel(plugin.getContext(), id.hashCode());
    });
  }

  /** onReply(callbackName)：注册 JS 回调名；直复到达后由插件回拨，携带 cardId 与答案。 */
  @JavascriptInterface
  public void onReply(String callbackName) {
    if (callbackName == null || callbackName.trim().isEmpty()) return;
    main.post(() -> plugin.setReplyCallback(callbackName.trim()));
  }

  /** setActiveSession(id)：H5 进入/离开会话详情页时同步，空串表示不在任何会话详情。 */
  @JavascriptInterface
  public void setActiveSession(String id) {
    AppVisibility.setActiveSession(id);
  }

  /** setBadge(count)：设置应用角标数量（随开放待办数变化）。 */
  @JavascriptInterface
  public void setBadge(int count) {
    main.post(() -> NotifyChannels.setBadge(plugin.getContext(), count));
  }

  /** 取消通知的薄封装，避免桥类直接依赖 android.app 之外的管理器类型。 */
  private static final class NotificationManagerHolder {
    static void cancel(Context ctx, int id) {
      android.app.NotificationManager nm = NotifyChannels.manager(ctx);
      if (nm != null) nm.cancel(id);
    }
  }
}
