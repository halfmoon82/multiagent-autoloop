package cool.autoloop.console.notify;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import androidx.core.app.RemoteInput;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * RemoteInput 锁屏直复广播：把选项/文字答案写回 POST /api/mobile/cards/:id/answer。
 * 成功后撤销通知；失败保留同一条通知并改为「直复失败，请重试」，草稿入口不丢。
 */
public class NotifyReplyReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context ctx, Intent intent) {
    if (!ForegroundService.ACTION_REPLY.equals(intent.getAction())) return;
    String cardId = intent.getStringExtra(ForegroundService.EXTRA_CARD_ID);
    if (cardId == null || cardId.isEmpty()) return;

    String answer = extractAnswer(intent);
    boolean ok = sendAnswer(ctx, cardId, answer);
    NotificationManager nm = NotifyChannels.manager(ctx);
    if (ok) {
      if (nm != null) nm.cancel(cardId.hashCode()); // 回复后通知撤销
      AutoLoopNotifications.onReplyReceived(cardId, answer); // 回拨 H5 onReply 回调
    } else {
      NotifyChannels.postReplyFailure(ctx, cardId); // 直复失败保留通知并提示
    }
  }

  private String extractAnswer(Intent intent) {
    Bundle results = RemoteInput.getResultsFromIntent(intent);
    if (results != null) {
      CharSequence text = results.getCharSequence(ForegroundService.KEY_TEXT_REPLY);
      if (text != null && text.length() > 0) return text.toString();
    }
    // 选项按钮把 label 直接放进 extra。
    String choice = intent.getStringExtra(ForegroundService.EXTRA_REPLY_TEXT);
    return choice == null ? "" : choice;
  }

  private boolean sendAnswer(Context ctx, String cardId, String answer) {
    HttpURLConnection conn = null;
    try {
      android.content.SharedPreferences sp =
          ctx.getSharedPreferences(NotifyChannels.PREFS, Context.MODE_PRIVATE);
      String base = sp.getString(ForegroundService.EXTRA_BASE_URL, "");
      String token = sp.getString(ForegroundService.EXTRA_DEVICE_TOKEN, "");
      conn = (HttpURLConnection) new URL(base + "/api/mobile/cards/" + cardId + "/answer")
          .openConnection();
      conn.setRequestMethod("POST");
      conn.setConnectTimeout(10_000);
      conn.setReadTimeout(10_000);
      conn.setRequestProperty("x-device-token", token);
      conn.setRequestProperty("x-console-request", "1");
      conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      conn.setDoOutput(true);
      JSONObject body = new JSONObject()
          .put("type", "text")
          .put("text", answer);
      try (OutputStream os = conn.getOutputStream()) {
        os.write(body.toString().getBytes(StandardCharsets.UTF_8));
      }
      return conn.getResponseCode() / 100 == 2;
    } catch (Exception e) {
      return false;
    } finally {
      if (conn != null) conn.disconnect();
    }
  }
}
