package cool.autoloop.console;

import android.os.Bundle;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import cool.autoloop.console.auth.AutoLoopBiometric;
import cool.autoloop.console.auth.AutoLoopDownloads;
import cool.autoloop.console.auth.AutoLoopSecureStorage;
import cool.autoloop.console.auth.AutoLoopWebChromeClient;
import cool.autoloop.console.notify.AutoLoopNotifications;
import cool.autoloop.console.speech.AutoLoopSpeech;

/** 自写插件的统一注册点：onCreate 之前 registerPlugin 全部插件，之后接好 WebView 客户端与桥。 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(AutoLoopBiometric.class);
    registerPlugin(AutoLoopSecureStorage.class);
    registerPlugin(AutoLoopNotifications.class);
    registerPlugin(AutoLoopSpeech.class);
    registerPlugin(AutoLoopDownloads.class);

    super.onCreate(savedInstanceState);

    final Bridge bridge = getBridge();
    // native-auth 节点只填 AutoLoopWebChromeClient 的实现，不改这里。
    bridge.getWebView().setWebChromeClient(new AutoLoopWebChromeClient());
    // 兜底下载监听：H5 下载走 AutoloopDownload.start 桥，普通链接跳转不带设备令牌会被 401 替换页面。
    bridge.getWebView().setDownloadListener(new AutoLoopDownloads.DownloadBridge());
    // 预置 JS 桥空实现；对应节点只填实现，未就绪时调用不抛错。
    bridge.getWebView().evaluateJavascript(
        "window.AutoloopHaptics = window.AutoloopHaptics || { tap: function(){}, success: function(){} };"
            + "window.AutoloopDownload = window.AutoloopDownload || { start: function(){ return false; } };"
            + "window.AutoloopApp = window.AutoloopApp || { exit: function(){} };",
        null);
  }

  @Override
  public void onBackPressed() {
    // 把系统返回键转成 H5 事件；任何页面都不得直接退出，Tab 根页的二次确认由 H5 负责。
    getBridge().getWebView().evaluateJavascript(
        "window.dispatchEvent(new Event('autoloop:back'))", null);
  }
}
