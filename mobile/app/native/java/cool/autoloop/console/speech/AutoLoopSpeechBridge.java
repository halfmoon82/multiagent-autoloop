package cool.autoloop.console.speech;

import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.Plugin;

import java.lang.ref.WeakReference;

/**
 * 原生桥适配层：把 Capacitor 插件的 isAvailable/start/stop 方法包装成 H5 契约的
 * window.AutoloopSpeech 全局对象；原生识别事件（部分结果/最终结果/错误）转成 DOM 事件，
 * 交给 onPartial/onFinal/onError 回调。H5 只拿到文字，由调用方决定是否使用，本机绝不自动发送。
 */
final class AutoLoopSpeechBridge {
  static final String SPEECH_SHIM =
      "window.AutoloopSpeech=(function(){"
          + "var onPartialCb=null,onFinalCb=null,onErrorCb=null;"
          + "function p(){return window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.AutoloopSpeech;}"
          + "window.addEventListener('autoloop:speech-partial',function(e){"
          + "if(typeof onPartialCb==='function')onPartialCb(String((e.detail&&e.detail.text)||''));});"
          + "window.addEventListener('autoloop:speech-final',function(e){"
          + "if(typeof onFinalCb==='function')onFinalCb(String((e.detail&&e.detail.text)||''));});"
          + "window.addEventListener('autoloop:speech-error',function(e){"
          + "if(typeof onErrorCb==='function')onErrorCb(e.detail||{code:'AUTOLOOP_SPEECH_UNKNOWN',message:'语音识别失败'});});"
          + "return {"
          + "isAvailable:function(){var x=p();if(!x)return Promise.resolve(false);"
          + "return x.isAvailable().then(function(r){return !!(r&&r.available);}).catch(function(){return false;});},"
          + "start:function(opts){var x=p();if(!x)return Promise.resolve(false);"
          + "return x.start(opts||{}).then(function(r){return !!(r&&r.started);}).catch(function(){return false;});},"
          + "stop:function(){var x=p();return x?x.stop():Promise.resolve(false);},"
          + "onPartial:function(cb){onPartialCb=cb;},"
          + "onFinal:function(cb){onFinalCb=cb;},"
          + "onError:function(cb){onErrorCb=cb;}"
          + "};})();";

  private static WeakReference<WebView> webViewRef = new WeakReference<>(null);

  private AutoLoopSpeechBridge() {}

  /** 插件 load 时注入 shim，并记下 WebView 供识别回调把文字回传 JS。 */
  static void inject(Plugin plugin) {
    Bridge bridge = plugin.getBridge();
    if (bridge == null) return;
    WebView webView = bridge.getWebView();
    if (webView == null) return;
    webViewRef = new WeakReference<>(webView);
    webView.evaluateJavascript(SPEECH_SHIM, null);
  }

  /** 把识别结果或错误码以纯字符串事件回传 JS（不拼不可信 HTML、不输出堆栈与凭据）。 */
  static void reportToJs(String event, String code, String message, String text) {
    WebView webView = webViewRef.get();
    if (webView == null) return;
    String js = "window.AutoloopSpeechEvent={code:'" + jsEscape(code)
        + "',message:'" + jsEscape(message)
        + "',text:'" + jsEscape(text == null ? "" : text) + "'};"
        + "window.dispatchEvent(new CustomEvent('" + event
        + "',{detail:window.AutoloopSpeechEvent}));";
    webView.evaluateJavascript(js, null);
  }

  private static String jsEscape(String s) {
    return s.replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029");
  }
}
