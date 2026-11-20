package cool.autoloop.console.auth;

import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.Plugin;

import java.lang.ref.WeakReference;

/**
 * 原生桥适配层。Capacitor 把插件方法暴露在 window.Capacitor.Plugins.<插件名>.<方法名>，
 * 但 H5 shell.mjs 用的是 window.Autoloop* 全局，且期望原始 token 字符串、原始布尔值与
 * start(url,name) 两参调用。这里在 WebView 同步注入 H5 契约的全局对象（方法内部再惰性取
 * Capacitor 插件代理），并缓存 WebView 供 WebChromeClient 回 JS 错误码。
 */
final class AutoLoopBridge {
  static final String SECURE_STORAGE_SHIM =
      "window.AutoloopSecureStorage={"
          + "get:function(){"
          + "var p=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.AutoloopSecureStorage;"
          + "if(!p)return Promise.resolve(null);"
          + "return p.nativeGet().then(function(r){"
          + "if(r&&r.error){window.AutoloopSecureStorageError={code:r.error,message:'安全存储不可用，请重启 App 后重新绑定'};"
          + "window.dispatchEvent(new CustomEvent('autoloop:secure-storage-error',{detail:window.AutoloopSecureStorageError}));}"
          + "return (r&&typeof r.value==='string')?r.value:null;"
          + "}).catch(function(){return null;});},"
          + "set:function(token){"
          + "var p=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.AutoloopSecureStorage;"
          + "return p?p.nativeSet({value:String(token)}):Promise.resolve();},"
          + "remove:function(){"
          + "var p=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.AutoloopSecureStorage;"
          + "return p?p.nativeRemove():Promise.resolve();}"
          + "};";

  static final String BIOMETRIC_SHIM =
      "window.AutoloopBiometric={"
          + "verify:function(){"
          + "var p=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.AutoloopBiometric;"
          + "if(!p)return Promise.resolve(false);"
          + "return p.nativeVerify().then(function(r){return !!(r&&r.ok);})"
          + ".catch(function(){return false;});}"
          + "};";

  static final String DOWNLOAD_SHIM =
      "window.AutoloopDownload={"
          + "start:function(url,name){"
          + "var p=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.AutoloopDownload;"
          + "if(!p)return Promise.resolve(false);"
          + "return p.nativeStart({url:String(url),name:String(name||'下载')})"
          + ".then(function(r){return !!(r&&r.started);}).catch(function(){return false;});}"
          + "};";

  private static WeakReference<WebView> webViewRef = new WeakReference<>(null);

  private AutoLoopBridge() {}

  /** 插件 load 时注入 shim，并记下 WebView 供 WebChromeClient 使用。 */
  static void inject(Plugin plugin, String shim) {
    Bridge bridge = plugin.getBridge();
    if (bridge == null) return;
    WebView webView = bridge.getWebView();
    if (webView == null) return;
    webViewRef = new WeakReference<>(webView);
    webView.evaluateJavascript(shim, null);
  }

  static WebView webView() {
    return webViewRef.get();
  }

  /** 把原生侧的错误码与说明回传 JS，供页面显示明确提示（不输出令牌与堆栈）。 */
  static void reportToJs(String event, String code, String message) {
    WebView webView = webView();
    if (webView == null) return;
    String js = "window.AutoloopNativeError={code:'" + code + "',message:'" + message + "'};"
        + "window.dispatchEvent(new CustomEvent('" + event + "',{detail:window.AutoloopNativeError}));";
    webView.evaluateJavascript(js, null);
  }
}
