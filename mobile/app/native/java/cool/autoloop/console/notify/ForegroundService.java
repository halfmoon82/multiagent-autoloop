package cool.autoloop.console.notify;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * dataSync 前台服务：常驻「NoMoTo 在线」通知 + App 退到后台仍轮询待办/节点完成 + 分渠道系统通知。
 * 网络错指数退避封顶；401 停服务并发「请重新绑定」；同一事项按 kind:id:revision 去重。
 */
public class ForegroundService extends Service {
  public static final String EXTRA_INTERVAL_MS = "intervalMs";
  public static final String EXTRA_DEVICE_TOKEN = "deviceToken";
  public static final String EXTRA_BASE_URL = "baseUrl";
  public static final String ACTION_REPLY = "cool.autoloop.console.notify.REPLY";
  public static final String EXTRA_CARD_ID = "cardId";
  public static final String EXTRA_REPLY_TEXT = "replyText";
  public static final String KEY_TEXT_REPLY = "autoloop_direct_reply";

  private static final String TAG = "AutoloopNotify";
  private static final long MIN_INTERVAL_MS = 15_000L;
  private static final long MAX_INTERVAL_MS = 15 * 60_000L;

  private Handler worker;
  private Runnable poll;
  private volatile long intervalMs = MIN_INTERVAL_MS;
  private volatile String deviceToken = "";
  private volatile String baseUrl = "";
  private volatile int failures = 0;
  private volatile boolean running = false;

  @Override
  public void onCreate() {
    super.onCreate();
    NotifyChannels.createAll(this);
    SharedPreferences sp = getSharedPreferences(NotifyChannels.PREFS, MODE_PRIVATE);
    deviceToken = sp.getString(EXTRA_DEVICE_TOKEN, "");
    baseUrl = sp.getString(EXTRA_BASE_URL, "");
    intervalMs = sp.getLong(EXTRA_INTERVAL_MS, MIN_INTERVAL_MS);

    HandlerThread thread = new HandlerThread("autoloop-notify");
    thread.start();
    worker = new Handler(thread.getLooper());
    poll = this::pollOnce;

  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null) {
      long requested = intent.getLongExtra(EXTRA_INTERVAL_MS, intervalMs);
      String token = intent.getStringExtra(EXTRA_DEVICE_TOKEN);
      String base = intent.getStringExtra(EXTRA_BASE_URL);
      if (token != null) deviceToken = token;
      if (base != null) baseUrl = base;
      intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(requested, MAX_INTERVAL_MS));
      getSharedPreferences(NotifyChannels.PREFS, MODE_PRIVATE).edit()
          .putLong(EXTRA_INTERVAL_MS, intervalMs)
          .putString(EXTRA_DEVICE_TOKEN, deviceToken)
          .putString(EXTRA_BASE_URL, baseUrl)
          .putBoolean("enabled", true)
          .apply();
    }
    // Android 14 起前台服务必须声明类型：与清单 dataSync 一致，且要在网络请求之前尽快调用。
    androidx.core.app.ServiceCompat.startForeground(this, NotifyChannels.ONLINE_ID,
        NotifyChannels.ongoing(this, NotifyChannels.getBadge(this)),
        android.os.Build.VERSION.SDK_INT >= 29
            ? android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0);
    running = true;
    failures = 0;
    worker.removeCallbacks(poll);
    worker.post(poll);
    // 被系统回收后由 START_STICKY 重拉；电池优化被杀后由下次打开 App 的插件 load() 重拉。
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    running = false;
    if (worker != null) worker.removeCallbacks(poll);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private void pollOnce() {
    if (!running) return;
    try {
      String json = fetch("/api/mobile/api/state", "GET", null);
      // 首轮只种子（把存量事项记为已通知），避免首次启动/重装后对存量刷屏。
      boolean seeding = !getSharedPreferences(NotifyChannels.PREFS, MODE_PRIVATE).getBoolean("seeded", false);
      handleState(json, seeding);
      try {
        handleSessions(fetch("/api/mobile/api/sessions", "GET", null), seeding);
      } catch (Http401 e) {
        throw e;
      } catch (Exception e) {
        Log.w(TAG, "会话回复轮询失败，不影响待办/节点完成通知", e); // 会话来源失败不拖垮主轮询
      }
      if (seeding) getSharedPreferences(NotifyChannels.PREFS, MODE_PRIVATE).edit().putBoolean("seeded", true).apply();
      failures = 0;
      schedule(intervalMs);
    } catch (Http401 e) {
      stopWithRebind();
    } catch (Exception e) {
      failures++;
      long backoff = Math.min(intervalMs * (1L << Math.min(failures, 6)), MAX_INTERVAL_MS);
      Log.w(TAG, "轮询失败，退避 " + backoff + "ms 后重试", e);
      schedule(backoff);
    }
  }

  private void schedule(long delay) {
    if (!running) return;
    worker.removeCallbacks(poll);
    worker.postDelayed(poll, delay);
  }

  private String fetch(String path, String method, String body) throws Exception {
    HttpURLConnection conn = (HttpURLConnection) new URL(baseUrl + path).openConnection();
    try {
      conn.setRequestMethod(method);
      conn.setConnectTimeout(10_000);
      conn.setReadTimeout(10_000);
      // 设备令牌只走请求头，绝不拼进通知内容或 URL。
      conn.setRequestProperty("x-device-token", deviceToken);
      conn.setRequestProperty("x-console-request", "1");
      if (body != null) {
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        try (OutputStream os = conn.getOutputStream()) {
          os.write(body.getBytes(StandardCharsets.UTF_8));
        }
      }
      int code = conn.getResponseCode();
      if (code == 401) throw new Http401();
      if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code);
      try (BufferedReader reader = new BufferedReader(
          new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) sb.append(line);
        return sb.toString();
      }
    } finally {
      conn.disconnect();
    }
  }

  private void handleState(String json, boolean seeding) throws org.json.JSONException {
    JSONObject root = new JSONObject(json);
    JSONArray cards = root.optJSONArray("cards");
    int badge = 0;
    if (cards != null) {
      for (int i = 0; i < cards.length(); i++) {
        JSONObject card = cards.optJSONObject(i);
        if (card == null || !"open".equals(card.optString("state"))) continue;
        badge++;
        String key = "todo:" + card.opt("id") + ":"
            + card.optString("createdAt", card.optString("updatedAt", ""));
        if (!NotifyChannels.claimPersistent(this, key) || seeding) continue; // 同一事项不重复通知
        NotifyChannels.postDescriptor(this, todoDescriptor(card, key), NotifyChannels.CHANNEL_TODO);
      }
    }
    NotifyChannels.setBadge(this, badge);

    JSONArray events = root.optJSONArray("nodeEvents");
    if (events != null) {
      for (int i = 0; i < events.length(); i++) {
        JSONObject event = events.optJSONObject(i);
        if (event == null || !"done".equals(event.optString("outcome"))) continue;
        String type = event.optString("type");
        if (!"dag.node.advance".equals(type) && !"dag.auto.dev.advance".equals(type)) continue;
        String advanceId = event.optString("advanceId", event.optString("id", ""));
        String key = "node-done:" + event.optString("runId") + ":"
            + event.optString("nodeId") + ":" + advanceId;
        if (!NotifyChannels.claimPersistent(this, key) || seeding) continue; // 同一事项不重复通知
        NotifyChannels.postDescriptor(this, nodeDoneDescriptor(event), NotifyChannels.CHANNEL_NODE_DONE);
      }
    }
  }

  /** 会话新回复：键 = session-reply:<id>:<agent 回复数>@<最后回复时间>，与 JS 契约一致。 */
  private void handleSessions(String json, boolean seeding) throws org.json.JSONException {
    JSONArray sessions = json.trim().startsWith("[") ? new JSONArray(json)
        : new JSONObject(json).optJSONArray("sessions");
    if (sessions == null) return;
    for (int i = 0; i < sessions.length(); i++) {
      JSONObject session = sessions.optJSONObject(i);
      if (session == null) continue;
      String sessionId = session.optString("id", "");
      JSONArray messages = session.optJSONArray("messages");
      if (sessionId.isEmpty() || messages == null) continue;
      int replies = 0;
      String lastAt = "";
      for (int j = 0; j < messages.length(); j++) {
        JSONObject message = messages.optJSONObject(j);
        if (message == null || !"agent".equals(message.optString("role"))) continue;
        replies++;
        lastAt = message.optString("at", "");
      }
      if (replies == 0) continue;
      String key = "session-reply:" + sessionId + ":" + replies + "@" + lastAt;
      if (!NotifyChannels.claimPersistent(this, key) || seeding) continue;
      if (!AppVisibility.shouldPushSession(sessionId)) continue; // 正在看该会话详情：视为已读
      NotifyChannels.postDescriptor(this, sessionDescriptor(session, sessionId, key), NotifyChannels.CHANNEL_SESSION);
    }
  }

  private static JSONObject todoDescriptor(JSONObject card, String key) {
    JSONObject d = new JSONObject();
    try {
      String id = String.valueOf(card.opt("id"));
      String title = card.optString("title", card.optString("summary", "待处理事项"));
      d.put("id", "todo:" + id).put("key", key).put("kind", "todo");
      d.put("title", "Autoloop 有待您决策的事项").put("body", title);
      d.put("click", new JSONObject().put("page", "todos").put("cardId", id));
      JSONArray options = card.optJSONArray("options");
      JSONArray choices = new JSONArray();
      if (options != null) for (int i = 0; i < options.length(); i++) {
        String label = String.valueOf(options.opt(i));
        choices.put(new JSONObject().put("id", label).put("label", label));
      }
      d.put("reply", new JSONObject().put("choices", choices).put("allowText", true));
    } catch (org.json.JSONException ignored) { /* 字段缺失用已写入部分 */ }
    return d;
  }

  private static JSONObject nodeDoneDescriptor(JSONObject event) {
    JSONObject d = new JSONObject();
    try {
      String nodeId = event.optString("nodeId", "");
      String title = event.optString("title", event.optString("summary", nodeId.isEmpty() ? "节点已完成" : "节点 " + nodeId + " 已完成"));
      d.put("id", "node-done:" + event.optString("runId") + ":" + nodeId + ":" + event.optString("advanceId", event.optString("id", "")));
      d.put("kind", "node-done").put("title", "Autoloop 节点已完成").put("body", title);
      d.put("click", new JSONObject().put("page", "node-delivery").put("runId", event.optString("runId")).put("nodeId", nodeId));
    } catch (org.json.JSONException ignored) { /* 同上 */ }
    return d;
  }

  private static JSONObject sessionDescriptor(JSONObject session, String sessionId, String key) {
    JSONObject d = new JSONObject();
    try {
      String kind = session.optString("kind", "scheduling");
      String label = "normal".equals(kind) ? "普通会话" : "design".equals(kind) ? "设计会话" : "调度会话";
      String prompt = session.optString("prompt", session.optString("title", "会话"));
      d.put("id", "session-reply:" + sessionId).put("key", key).put("kind", "session-reply");
      d.put("title", "Autoloop " + label + "有新回复").put("body", prompt.length() > 80 ? prompt.substring(0, 80) : prompt);
      d.put("click", new JSONObject().put("page", "session").put("sessionId", sessionId));
    } catch (org.json.JSONException ignored) { /* 同上 */ }
    return d;
  }

  private void stopWithRebind() {
    running = false;
    if (worker != null) worker.removeCallbacks(poll);
    NotifyChannels.manager(this).notify(NotifyChannels.REBIND_ID,
        NotifyChannels.rebindNotification(this));
    stopForeground(true);
    stopSelf();
  }

  /** 401 专用信号：与网络错区分，避免退避重试。 */
  private static final class Http401 extends Exception {
    private static final long serialVersionUID = 1L;
  }
}
