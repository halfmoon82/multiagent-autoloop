package cool.autoloop.console.auth;

import android.content.Context;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executor;

/**
 * 系统生物识别插件。用 androidx.biometric，BIOMETRIC_WEAK | DEVICE_CREDENTIAL 兜底：
 * 旧鸿蒙没有生物硬件但有设备密码（PIN/图案/密码）时仍可解锁，不依赖谷歌服务。
 * 成功 resolve ok=true；取消/失败 reject，H5 createBiometricGate 捕获后按 false 处理，绝不静默放行。
 */
@CapacitorPlugin(name = "AutoloopBiometric")
public class AutoLoopBiometric extends Plugin {
  private static final String ERR_UNAVAILABLE = "AUTOLOOP_BIOMETRIC_UNAVAILABLE";
  private static final String ERR_ERROR = "AUTOLOOP_BIOMETRIC_ERROR";
  private static final String ERR_FAILED = "AUTOLOOP_BIOMETRIC_FAILED";
  private static final int AUTHENTICATORS =
      BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

  @Override
  public void load() {
    super.load();
    AutoLoopBridge.inject(this, AutoLoopBridge.BIOMETRIC_SHIM);
  }

  @PluginMethod
  public void nativeVerify(PluginCall call) {
    Context context = getContext();
    if (context == null) {
      call.reject(ERR_UNAVAILABLE, "当前设备没有可用的系统生物识别，请在已安装的 App 内打开");
      return;
    }

    BiometricManager manager = BiometricManager.from(context);
    int status = manager.canAuthenticate(AUTHENTICATORS);
    if (status != BiometricManager.BIOMETRIC_SUCCESS) {
      call.reject(ERR_UNAVAILABLE, "当前设备没有可用的系统生物识别或设备密码");
      return;
    }

    Executor executor = ContextCompat.getMainExecutor(context);
    BiometricPrompt prompt = new BiometricPrompt(getActivity(), executor, new BiometricPrompt.AuthenticationCallback() {
      @Override
      public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
        call.resolve(new JSObject().put("ok", true));
      }

      @Override
      public void onAuthenticationError(int errorCode, CharSequence errString) {
        call.reject(ERR_ERROR, errString == null ? "生物识别失败" : errString.toString());
      }

      @Override
      public void onAuthenticationFailed() {
        call.reject(ERR_FAILED, "生物识别未通过，请重试");
      }
    });

    BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
        .setTitle("解锁 Autoloop")
        .setSubtitle("请使用指纹、面部或设备密码")
        .setAllowedAuthenticators(AUTHENTICATORS)
        .build();
    prompt.authenticate(info);
  }
}
