package cool.autoloop.console.auth;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.os.Build;
import android.net.Uri;
import android.os.Environment;
import android.webkit.DownloadListener;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 产物下载接缝：H5 一律调用 AutoloopDownload.start；DownloadListener 只作兜底，不做普通链接跳转。 */
@CapacitorPlugin(name = "AutoloopDownload")
public class AutoLoopDownloads extends Plugin {
  private static final String ERR_INVALID_URL = "AUTOLOOP_DOWNLOAD_INVALID_URL";
  private static final String ERR_NO_TOKEN = "AUTOLOOP_DOWNLOAD_NO_TOKEN";

  @Override
  public void load() {
    super.load();
    AutoLoopBridge.inject(this, AutoLoopBridge.DOWNLOAD_SHIM);
    registerCompleteReceiver();
  }

  /** 下载结束（成功/失败）时通知页面，页面内给轻提示；系统通知栏提示保持不变。 */
  private void registerCompleteReceiver() {
    BroadcastReceiver receiver = new BroadcastReceiver() {
      @Override
      public void onReceive(Context context, Intent intent) {
        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
        if (id < 0) return;
        boolean ok = false;
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        try (Cursor c = manager.query(new DownloadManager.Query().setFilterById(id))) {
          if (c != null && c.moveToFirst()) {
            ok = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                == DownloadManager.STATUS_SUCCESSFUL;
          }
        } catch (Exception ignored) {
          ok = false;
        }
        WebView webView = AutoLoopBridge.webView();
        if (webView == null) return;
        final String js = "window.dispatchEvent(new CustomEvent('autoloop:download-complete',{detail:{id:"
            + id + ",ok:" + ok + "}}));";
        webView.post(() -> webView.evaluateJavascript(js, null));
      }
    };
    IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
    if (Build.VERSION.SDK_INT >= 33) {
      getContext().registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
    } else {
      getContext().registerReceiver(receiver, filter);
    }
  }

  @PluginMethod
  public void nativeStart(PluginCall call) {
    String url = call.getString("url");
    String name = call.getString("name");
    if (url == null || !url.startsWith("https://")) {
      call.reject(ERR_INVALID_URL, "下载地址必须是 https");
      return;
    }
    String token;
    try {
      token = AutoLoopSecureStorage.readToken(getContext());
    } catch (Exception e) {
      token = null;
    }
    if (token == null || token.isEmpty()) {
      call.reject(ERR_NO_TOKEN, "设备凭据不可用，请重新绑定后再下载");
      return;
    }
    if (name == null || name.isEmpty()) name = "download";

    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
    request.addRequestHeader("x-device-token", token);
    // 服务端移动网关写/读路由校验一律要求控制台请求标记（x-device-token 只管设备鉴权）。
    request.addRequestHeader("x-console-request", "1");
    request.setTitle(name);
    request.setDescription("正在下载 " + name);
    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);

    DownloadManager manager =
        (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    long id = manager.enqueue(request);
    call.resolve(new JSObject().put("started", true).put("id", id));
  }

  /**
   * 兜底监听器：WebView 自行识别到 attachment 时，提示 H5 走 AutoloopDownload.start 带令牌下载，
   * 绝不退化成不带 x-device-token 的普通跳转（那样会被服务端 401 替换页面）。
   */
  public static final class DownloadBridge implements DownloadListener {
    @Override
    public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
      WebView webView = AutoLoopBridge.webView();
      if (webView == null) return;
      webView.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('autoloop:download-fallback',{detail:{url:'" + url + "'}}));",
          null);
    }
  }
}
