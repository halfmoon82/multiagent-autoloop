package cool.autoloop.console.speech;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
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

  private SpeechRecognizer recognizer;
  private boolean listening;
  private PluginCall pendingCall;

  @Override
  public void load() {
    super.load();
    AutoLoopSpeechBridge.inject(this);
  }

  @PluginMethod
  public void isAvailable(PluginCall call) {
    Context context = getContext();
    boolean available = context != null && SpeechRecognizer.isRecognitionAvailable(context);
    JSObject result = new JSObject();
    result.put("available", available);
    call.resolve(result);
  }

  @PluginMethod
  public void start(PluginCall call) {
    Context context = getContext();
    if (context == null) {
      fail(call, ERR_NO_SERVICE, "当前环境没有可用的语音识别服务");
      return;
    }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      fail(call, ERR_NO_SERVICE, "当前设备没有可用的系统语音识别服务");
      return;
    }
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      // 运行时申请录音权限；授予后再真正开始，绝不在未授权时开麦。
      pendingCall = call;
      requestRecordAudio();
      return;
    }
    doStart(call);
  }

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
          if (granted) doStart(call);
          else fail(call, ERR_PERMISSION, "麦克风权限被拒绝，请用键盘输入");
        });
  }

  private void doStart(PluginCall call) {
    if (listening) {
      fail(call, ERR_BUSY, "正在聆听中");
      return;
    }
    Context context = getContext();
    try {
      releaseRecognizer();
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
      // 识别服务异常不崩溃，给 JS 明确错误码。
      releaseRecognizer();
      fail(call, ERR_NO_SERVICE, "语音识别启动失败，请用键盘输入");
    }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    releaseRecognizer();
    JSObject result = new JSObject();
    result.put("stopped", true);
    call.resolve(result);
  }

  private void fail(PluginCall call, String code, String message) {
    AutoLoopSpeechBridge.reportToJs(EVENT_ERROR, code, message, "");
    JSObject result = new JSObject();
    result.put("started", false);
    result.put("error", code);
    call.resolve(result);
  }

  private void releaseRecognizer() {
    listening = false;
    if (recognizer != null) {
      try { recognizer.stopListening(); } catch (Exception ignored) { /* 不崩溃 */ }
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
    }
  }

  private static String firstText(Bundle bundle) {
    if (bundle == null) return "";
    ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
    if (matches == null || matches.isEmpty()) return "";
    return matches.get(0);
  }
}
