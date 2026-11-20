package cool.autoloop.console.speech;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Locale;

/**
 * 系统语音识别插件。用平台 SpeechRecognizer（系统/厂商识别服务，不依赖谷歌服务），
 * 运行时申请 RECORD_AUDIO。isAvailable 在无识别服务时返回 false；拒权/无网/超时通过
 * autoloop:speech-error 回 JS 明确错误码，不崩溃；识别文字只回传，绝不自动发送。
 *
 * 线程约束：Capacitor 6 的 @PluginMethod 默认在后台线程回调，而 SpeechRecognizer 启停与
 * Fragment 权限申请要求主线程。这类调用统一经 runOnMain 投递，避免真机上被吞成「没有识别
 * 服务」；JS 回传由 AutoLoopSpeechBridge 用 WebView.post 投递主线程。
 */
@CapacitorPlugin(name = "AutoloopSpeech")
public class AutoLoopSpeech extends Plugin {
  private static final int REQ_RECORD_AUDIO = 0x5A17;
  private static final String EVENT_PARTIAL = "autoloop:speech-partial";
  private static final String EVENT_FINAL = "autoloop:speech-final";
  private static final String EVENT_ERROR = "autoloop:speech-error";

  private static final String ERR_NO_SERVICE = "AUTOLOOP_SPEECH_NO_SERVICE";
  private static final String ERR_PERMISSION = "AUTOLOOP_SPEECH_PERMISSION_DENIED";
  private static final String ERR_NETWORK = "AUTOLOOP_SPEECH_NETWORK";
  private static final String ERR_TIMEOUT = "AUTOLOOP_SPEECH_TIMEOUT";
  private static final String ERR_BUSY = "AUTOLOOP_SPEECH_BUSY";
  private static final String ERR_UNKNOWN = "AUTOLOOP_SPEECH_UNKNOWN";

  private static final long RELEASE_DELAY_MS = 1500L;

  private SpeechRecognizer recognizer;
  private boolean listening;
  private PluginCall pendingCall;
  private Runnable pendingRelease;
  private final Handler mainHandler = new Handler(Looper.getMainLooper());

  @Override
  public void load() {
    super.load();
    AutoLoopSpeechBridge.inject(this);
  }

  /** Capacitor 插件方法在后台线程执行；统一投递到主线程后再碰主线程专属 API。 */
  private void runOnMain(Runnable task) {
    Activity activity = getActivity();
    if (activity != null) activity.runOnUiThread(task);
    else mainHandler.post(task);
  }

  @PluginMethod
  public void isAvailable(PluginCall call) {
    runOnMain(() -> {
      Context context = getContext();
      boolean available = context != null && SpeechRecognizer.isRecognitionAvailable(context);
      JSObject result = new JSObject();
      result.put("available", available);
      call.resolve(result);
    });
  }

  @PluginMethod
  public void start(PluginCall call) {
    runOnMain(() -> startOnMain(call));
  }

  /** 主线程：校验服务与权限；未授权时申请，授予后再真正开始。 */
  private void startOnMain(PluginCall call) {
    Context context = getContext();
    if (context == null) {
      fail(call, ERR_NO_SERVICE, "当前环境没有可用的语音识别服务");
      return;
    }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      fail(call, ERR_NO_SERVICE, "当前设备没有可用的系统语音识别服务");
      return;
    }
    if (pendingCall != null) {
      fail(call, ERR_BUSY, "正在申请麦克风权限，请稍后再试");
      return;
    }
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      // 运行时申请录音权限；授予后再真正开始，绝不在未授权时开麦。
      pendingCall = call;
      requestRecordAudio();
      return;
    }
    doStartOnMain(call);
  }

  /** 主线程：headless Fragment 申请权限并接收结果。 */
  private void requestRecordAudio() {
    Activity activity = getActivity();
    if (!(activity instanceof FragmentActivity)) {
      PluginCall call = pendingCall;
      pendingCall = null;
      if (call != null) fail(call, ERR_PERMISSION, "当前页面无法申请麦克风权限");
      return;
    }
    SpeechPermissionFragment.attach((FragmentActivity) activity).requestRuntimePermissions(
        new String[]{Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO,
        granted -> {
          PluginCall call = pendingCall;
          pendingCall = null;
          if (call == null) return;
          if (granted) doStartOnMain(call);
          else fail(call, ERR_PERMISSION, "麦克风权限被拒绝，请用键盘输入");
        });
  }

  /** 主线程：创建并启动识别器；语音服务异常转明确错误码，不崩溃。 */
  private void doStartOnMain(PluginCall call) {
    if (listening) {
      fail(call, ERR_BUSY, "正在聆听中");
      return;
    }
    Context context = getContext();
    try {
      cancelScheduledRelease();
      releaseRecognizerNow();
      recognizer = SpeechRecognizer.createSpeechRecognizer(context);
      recognizer.setRecognitionListener(new SpeechListener());
      Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
      intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
      intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
      intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
      intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
      recognizer.startListening(intent);
      listening = true;
      JSObject result = new JSObject();
      result.put("started", true);
      call.resolve(result);
    } catch (Exception e) {
      releaseRecognizerNow();
      fail(call, ERR_NO_SERVICE, "语音识别启动失败，请用键盘输入");
    }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    runOnMain(() -> {
      // 先 stopListening 让最终文字有机会经 onResults 回传，不在此处同步 destroy。
      if (recognizer != null) {
        try { recognizer.stopListening(); } catch (Exception ignored) { /* 不崩溃 */ }
        scheduleRelease();
      }
      listening = false;
      JSObject result = new JSObject();
      result.put("stopped", true);
      call.resolve(result);
    });
  }

  /** 主线程：没有识别回调时延迟释放，避免识别器泄漏；新 start 会取消它。 */
  private void scheduleRelease() {
    cancelScheduledRelease();
    pendingRelease = () -> {
      pendingRelease = null;
      releaseRecognizerNow();
    };
    mainHandler.postDelayed(pendingRelease, RELEASE_DELAY_MS);
  }

  private void cancelScheduledRelease() {
    if (pendingRelease != null) {
      mainHandler.removeCallbacks(pendingRelease);
      pendingRelease = null;
    }
  }

  private void fail(PluginCall call, String code, String message) {
    // reportToJs 内部用 WebView.post 投递主线程，调用方线程无关。
    AutoLoopSpeechBridge.reportToJs(EVENT_ERROR, code, message, "");
    JSObject result = new JSObject();
    result.put("started", false);
    result.put("error", code);
    call.resolve(result);
  }

  /** 仅从主线程路径调用：销毁识别器，释放麦克风。 */
  private void releaseRecognizerNow() {
    listening = false;
    cancelScheduledRelease();
    if (recognizer != null) {
      try { recognizer.destroy(); } catch (Exception ignored) { /* 不崩溃 */ }
      recognizer = null;
    }
  }

  private final class SpeechListener implements RecognitionListener {
    @Override public void onReadyForSpeech(Bundle params) {}
    @Override public void onBeginningOfSpeech() {}
    @Override public void onRmsChanged(float rmsdB) {}
    @Override public void onBufferReceived(byte[] buffer) {}
    @Override public void onEndOfSpeech() { listening = false; }
    @Override public void onEvent(int eventType, Bundle params) {}

    @Override public void onPartialResults(Bundle partialResults) {
      AutoLoopSpeechBridge.reportToJs(EVENT_PARTIAL, "", "", firstText(partialResults));
    }

    @Override public void onResults(Bundle results) {
      listening = false;
      AutoLoopSpeechBridge.reportToJs(EVENT_FINAL, "", "", firstText(results));
      releaseRecognizerNow();
    }

    @Override public void onError(int error) {
      listening = false;
      String code;
      String message;
      switch (error) {
        case SpeechRecognizer.ERROR_NETWORK:
        case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
          code = ERR_NETWORK; message = "网络不可用，语音识别失败"; break;
        case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
          code = ERR_TIMEOUT; message = "没有听清，请重试"; break;
        case SpeechRecognizer.ERROR_NO_MATCH:
          code = ERR_TIMEOUT; message = "没有识别到语音，请重试"; break;
        case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
          code = ERR_PERMISSION; message = "麦克风权限被拒绝，请用键盘输入"; break;
        case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
          code = ERR_BUSY; message = "识别服务忙，请稍后重试"; break;
        default:
          code = ERR_UNKNOWN; message = "语音识别失败，请用键盘输入"; break;
      }
      AutoLoopSpeechBridge.reportToJs(EVENT_ERROR, code, message, "");
      releaseRecognizerNow();
    }
  }

  private static String firstText(Bundle bundle) {
    if (bundle == null) return "";
    ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
    if (matches == null || matches.isEmpty()) return "";
    return matches.get(0);
  }
}
