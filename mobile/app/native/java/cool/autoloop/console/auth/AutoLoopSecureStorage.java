package cool.autoloop.console.auth;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 设备凭证安全存储。EncryptedSharedPreferences + MasterKey（Android Keystore）落盘，
 * 不写浏览器 DOM 存储、不写日志。Keystore 异常时回退进程内存，并向 JS 报
 * AUTOLOOP_STORAGE_UNAVAILABLE，提示重启后需重新绑定。
 */
@CapacitorPlugin(name = "AutoloopSecureStorage")
public class AutoLoopSecureStorage extends Plugin {
  private static final String PREFS_NAME = "autoloop_secure_prefs";
  private static final String KEY_DEVICE_TOKEN = "device_token";
  static final String ERR_STORAGE = "AUTOLOOP_STORAGE_UNAVAILABLE";

  private String memoryToken;
  private boolean keystoreFailed;

  @Override
  public void load() {
    super.load();
    AutoLoopBridge.inject(this, AutoLoopBridge.SECURE_STORAGE_SHIM);
  }

  @PluginMethod
  public void nativeGet(PluginCall call) {
    JSObject result = new JSObject();
    if (keystoreFailed) {
      result.put("value", memoryToken);
      result.put("error", ERR_STORAGE);
      call.resolve(result);
      return;
    }
    try {
      result.put("value", readToken(getContext()));
      call.resolve(result);
    } catch (Exception e) {
      keystoreFailed = true;
      result.put("value", memoryToken);
      result.put("error", ERR_STORAGE);
      call.resolve(result);
    }
  }

  @PluginMethod
  public void nativeSet(PluginCall call) {
    String token = call.getString("value");
    JSObject result = new JSObject().put("ok", token != null);
    if (token == null) {
      call.reject(ERR_STORAGE, "设备凭证为空，请重新绑定");
      return;
    }
    if (keystoreFailed) {
      memoryToken = token;
      result.put("error", ERR_STORAGE);
      call.resolve(result);
      return;
    }
    try {
      prefs(getContext()).edit().putString(KEY_DEVICE_TOKEN, token).apply();
      call.resolve(result);
    } catch (Exception e) {
      keystoreFailed = true;
      memoryToken = token;
      result.put("error", ERR_STORAGE);
      call.resolve(result);
    }
  }

  @PluginMethod
  public void nativeRemove(PluginCall call) {
    memoryToken = null;
    JSObject result = new JSObject().put("ok", true);
    if (keystoreFailed) {
      result.put("error", ERR_STORAGE);
      call.resolve(result);
      return;
    }
    try {
      prefs(getContext()).edit().remove(KEY_DEVICE_TOKEN).apply();
      call.resolve(result);
    } catch (Exception e) {
      keystoreFailed = true;
      result.put("error", ERR_STORAGE);
      call.resolve(result);
    }
  }

  /** 供下载插件从同一份安全存储读取设备令牌；Keystore 异常时返回 null，不发带错令牌的请求。 */
  static String readToken(Context context) throws Exception {
    if (context == null) return null;
    return prefs(context).getString(KEY_DEVICE_TOKEN, null);
  }

  private static SharedPreferences prefs(Context context) throws Exception {
    MasterKey masterKey = new MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build();
    return EncryptedSharedPreferences.create(
        context,
        PREFS_NAME,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
  }
}
