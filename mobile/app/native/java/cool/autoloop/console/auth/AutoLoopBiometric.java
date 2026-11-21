package cool.autoloop.console.auth;

import android.app.Activity;
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
  // 按顺序尝试：生物识别+设备密码 → 仅生物识别 → 仅设备密码。旧系统（API 23-29）不支持组合时逐级降级，
  // 避免有指纹或锁屏密码的设备被一刀切判为「不可用」而永远进不去。
  private static final int[] AUTHENTICATOR_CHOICES = {
      BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL,
      BiometricManager.Authenticators.BIOMETRIC_WEAK,
      BiometricManager.Authenticators.DEVICE_CREDENTIAL,
  };

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
    int authenticators = -1;
    for (int choice : AUTHENTICATOR_CHOICES) {
      if (manager.canAuthenticate(choice) == BiometricManager.BIOMETRIC_SUCCESS) {
        authenticators = choice;
        break;
      }
    }
    if (authenticators == -1) {
      call.reject(ERR_UNAVAILABLE, "当前设备没有可用的系统生物识别或设备密码");
      return;
    }
    final boolean allowsCredential =
        (authenticators & BiometricManager.Authenticators.DEVICE_CREDENTIAL) != 0;

    final Activity activity = getActivity();
    if (activity == null) {
      call.reject(ERR_UNAVAILABLE, "当前页面不在前台，请回到 App 后重试");
      return;
    }
    final int chosen = authenticators;
    // Capacitor 默认在后台线程执行插件方法，BiometricPrompt 必须在主线程创建与展示，
    // 否则弹窗不出或抛异常，页面只会看到「生物识别未通过」而永远进不去。
    activity.runOnUiThread(() -> {
      try {
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
            // 单次指纹/人脸未匹配时系统提示框仍开着，用户可继续重试；此处不能 reject，
            // 否则第一次没按准就把整次解锁判失败。最终结果只由 Succeeded / Error 决定。
          }
        });

        BiometricPrompt.PromptInfo.Builder builder = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("解锁 NoMoTo")
            .setSubtitle("请使用指纹、面部或设备密码")
            .setAllowedAuthenticators(chosen);
        // 允许设备密码时系统自带「使用密码」入口，不能再设取消按钮文案；否则必须设置。
        if (!allowsCredential) builder.setNegativeButtonText("取消");
        prompt.authenticate(builder.build());
      } catch (Exception e) {
        call.reject(ERR_ERROR, "无法打开系统验证窗口，请稍后重试");
      }
    });
  }
}
