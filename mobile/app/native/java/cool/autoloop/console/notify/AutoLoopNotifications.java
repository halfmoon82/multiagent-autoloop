package cool.autoloop.console.notify;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * 通知 Capacitor 插件：load() 注入 window.AutoloopNotify 并申请 Android 13+ 通知权限，
 * 按持久化配置在前台服务被电池优化杀死后、下次打开 App 时自动重启。
 */
@CapacitorPlugin(name = "AutoloopNotifications")
public class AutoLoopNotifications extends Plugin {
  private static final String TAG = "AutoloopNotify";
  private static final int REQ_POST_NOTIFICATIONS = 71;

  private static volatile AutoLoopNotifications instance;
  private volatile String replyCallback;

  @Override
  public void load() {
    super.load();
    instance = this;

    // 注入 window.AutoloopNotify：JS 全局对象暴露 start/stop/notify/cancel/onReply/setBadge。
    getBridge().getWebView().addJavascriptInterface(
        new AutoloopNotifyBridge(this), "AutoloopNotify");

    requestNotificationsPermission();
    restartIfEnabled();
    dispatchLaunchRoute(getActivity() != null ? getActivity().getIntent() : null);

    // 电池优化状态只作诊断；被杀后由下次打开 App 的 restartIfEnabled 重新拉起。
    PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
    if (pm != null && Build.VERSION.SDK_INT >= 23
        && !pm.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
      Log.i(TAG, "电池优化未豁免：前台服务被杀后将在下次打开 App 时自动重启");
    }
  }

  /** Android 13+ 运行时请求 POST_NOTIFICATIONS，未授权时系统通知不会显示。 */
  private void requestNotificationsPermission() {
    if (Build.VERSION.SDK_INT >= 33) {
      if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
          != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(getActivity(),
            new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIFICATIONS);
      }
    }
  }

  /** 打开 App 时若上次启用过保活，按持久化配置重新拉起 dataSync 前台服务。 */
  private void restartIfEnabled() {
    SharedPreferences sp = getContext().getSharedPreferences(NotifyChannels.PREFS, Context.MODE_PRIVATE);
    if (!sp.getBoolean("enabled", false)) return;
    Intent intent = new Intent(getContext(), ForegroundService.class);
    intent.putExtra(ForegroundService.EXTRA_DEVICE_TOKEN, sp.getString(ForegroundService.EXTRA_DEVICE_TOKEN, ""));
    intent.putExtra(ForegroundService.EXTRA_INTERVAL_MS, sp.getLong(ForegroundService.EXTRA_INTERVAL_MS, 15_000L));
    intent.putExtra(ForegroundService.EXTRA_BASE_URL, sp.getString(ForegroundService.EXTRA_BASE_URL, ""));
    ContextCompat.startForegroundService(getContext(), intent);
  }

  @Override
  protected void handleOnStart() { AppVisibility.setForeground(true); }

  @Override
  protected void handleOnResume() { AppVisibility.setForeground(true); }

  @Override
  protected void handleOnPause() { AppVisibility.setForeground(false); }

  @Override
  protected void handleOnStop() { AppVisibility.setForeground(false); }

  @Override
  protected void handleOnNewIntent(Intent intent) {
    super.handleOnNewIntent(intent);
    dispatchLaunchRoute(intent);
  }

  /** 点击通知拉起 App 时带的路由（页面 + 会话/卡片/节点 id），回拨给 H5 定位。 */
  private void dispatchLaunchRoute(Intent intent) {
    if (intent == null) return;
    String page = intent.getStringExtra(NotifyChannels.EXTRA_ROUTE_PAGE);
    if (page == null || page.isEmpty()) return;
    JSONObject route = new JSONObject();
    try {
      route.put("page", page);
      route.put("sessionId", intent.getStringExtra(NotifyChannels.EXTRA_ROUTE_SESSION));
      route.put("cardId", intent.getStringExtra(NotifyChannels.EXTRA_ROUTE_CARD));
    } catch (Exception ignored) { return; }
    String js = "window.dispatchEvent(new CustomEvent('autoloop:notify-open',{detail:" + route + "}));";
    getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript(js, null));
  }

  @PluginMethod
  public void setBadge(PluginCall call) {
    NotifyChannels.setBadge(getContext(), call.getInt("count", 0));
    call.resolve();
  }

  @PluginMethod
  public void refresh(PluginCall call) {
    // 触发一次即时轮询：服务 onStartCommand 会立刻 post 一次 poll。
    ContextCompat.startForegroundService(getContext(), new Intent(getContext(), ForegroundService.class));
    call.resolve();
  }

  /** 注册 H5 直复回调名；仅接受合法 JS 标识符，避免拼接执行任意脚本。 */
  void setReplyCallback(String callbackName) {
    if (callbackName == null || !callbackName.matches("[A-Za-z_$][A-Za-z0-9_$]*")) return;
    this.replyCallback = callbackName;
  }

  /** 直复到达后回拨 H5，使其能同步本地待办/角标状态。 */
  static void onReplyReceived(String cardId, String answer) {
    AutoLoopNotifications self = instance;
    if (self == null || self.replyCallback == null) return;
    String js = "if (typeof window." + self.replyCallback + " === 'function') window."
        + self.replyCallback + "(" + JSONObject.quote(cardId) + ", " + JSONObject.quote(answer) + ");";
    self.getBridge().getWebView().evaluateJavascript(js, null);
  }
}
