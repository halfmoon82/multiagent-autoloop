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

import java.net.URI;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 设备凭证安全存储。EncryptedSharedPreferences + MasterKey（Android Keystore）落盘，
 * 不写浏览器 DOM 存储、不写日志。Keystore 异常时回退进程内存，并向 JS 报
 * AUTOLOOP_STORAGE_UNAVAILABLE，提示重启后需重新绑定。
 *
 * 多控制台（console-hub）：nativeGet/nativeSet/nativeRemove 可带 key——每台控制台的设备凭证按
 * {@code <host>:device-token} 分 key；另有控制台清单 {@code consoles} 与当前控制台 {@code current-console}。
 * key 只接受这三类固定形态，拒绝任意键名。不带 key 时沿用旧的单凭证键（向后兼容旧壳）。
 * 会话解锁标记（nativeSessionGet/nativeSessionSet）只在进程内存：解锁一次管全部控制台，App 被杀即失效。
 */
@CapacitorPlugin(name = "AutoloopSecureStorage")
public class AutoLoopSecureStorage extends Plugin {
  private static final String PREFS_NAME = "autoloop_secure_prefs";
  // Keystore 失效（部分 ROM 覆盖安装后废密钥）时的落盘兜底：普通私有 SharedPreferences。
  // 安全性降级但仍在应用沙箱内；换来的是绑定凭证跨冷启动存活——否则每次杀 App 都回绑定页（2026-11-24 真机）。
  private static final String PREFS_FALLBACK_NAME = "autoloop_secure_prefs_plain";
  private static final String KEY_DEVICE_TOKEN = "device_token";
  private static final String KEY_CONSOLES = "consoles";
  private static final String KEY_CURRENT_CONSOLE = "current-console";
  private static final String TOKEN_SUFFIX = ":device-token";
  private static final Pattern TOKEN_KEY = Pattern.compile("^[A-Za-z0-9.\\-\\[\\]:]{1,300}:device-token$");
  static final String ERR_STORAGE = "AUTOLOOP_STORAGE_UNAVAILABLE";
  static final String ERR_KEY = "AUTOLOOP_STORAGE_INVALID_KEY";

  /** Keystore 不可用时的进程内存回退（按 key 分存）；不落盘、不写日志。 */
  private final Map<String, String> memoryTokens = new HashMap<>();
  private boolean keystoreFailed;
  /** 会话解锁标记：进程级内存，切换控制台重建页面后免重复生物识别；进程被杀即回到需要验证。 */
  private static volatile boolean sessionUnlocked;

  @Override
  public void load() {
    super.load();
    AutoLoopBridge.inject(this, AutoLoopBridge.SECURE_STORAGE_SHIM);
  }

  /** 解析调用方 key：缺省走旧单凭证键；非法键返回 null（调用方拒绝）。 */
  static String resolveKey(String key) {
    if (key == null) return KEY_DEVICE_TOKEN;
    if (KEY_CONSOLES.equals(key) || KEY_CURRENT_CONSOLE.equals(key)) return key;
    if (TOKEN_KEY.matcher(key).matches()) return key;
    return null;
  }

  @PluginMethod
  public void nativeGet(PluginCall call) {
    String key = resolveKey(call.getString("key"));
    if (key == null) {
      call.reject(ERR_KEY, "安全存储键名不合法");
      return;
    }
    JSObject result = new JSObject();
    if (keystoreFailed) {
      String plain = readPlain(getContext(), key);
      result.put("value", plain != null ? plain : memoryTokens.get(key));
      result.put("error", ERR_STORAGE);
      call.resolve(result);
      return;
    }
    try {
      result.put("value", prefs(getContext()).getString(key, null));
      call.resolve(result);
    } catch (Exception e) {
      keystoreFailed = true;
      String plain = readPlain(getContext(), key);
      result.put("value", plain != null ? plain : memoryTokens.get(key));
      result.put("error", ERR_STORAGE);
      call.resolve(result);
    }
  }

  @PluginMethod
  public void nativeSet(PluginCall call) {
    String key = resolveKey(call.getString("key"));
    if (key == null) {
      call.reject(ERR_KEY, "安全存储键名不合法");
      return;
    }
    String token = call.getString("value");
    JSObject result = new JSObject().put("ok", token != null);
    if (token == null) {
      call.reject(ERR_STORAGE, "设备凭证为空，请重新绑定");
      return;
    }
    if (keystoreFailed) {
      memoryTokens.put(key, token);
      writePlain(getContext(), key, token);
      result.put("error", ERR_STORAGE);
      call.resolve(result);
      return;
    }
    try {
      prefs(getContext()).edit().putString(key, token).apply();
      // 同步镜像到兜底存储：Keystore 日后失效时旧凭证仍可读，不再丢绑定。
      writePlain(getContext(), key, token);
      call.resolve(result);
    } catch (Exception e) {
      keystoreFailed = true;
      memoryTokens.put(key, token);
      writePlain(getContext(), key, token);
      result.put("error", ERR_STORAGE);
      call.resolve(result);
    }
  }

  @PluginMethod
  public void nativeRemove(PluginCall call) {
    String key = resolveKey(call.getString("key"));
    if (key == null) {
      call.reject(ERR_KEY, "安全存储键名不合法");
      return;
    }
    memoryTokens.remove(key);
    removePlain(getContext(), key);
    JSObject result = new JSObject().put("ok", true);
    if (keystoreFailed) {
      result.put("error", ERR_STORAGE);
      call.resolve(result);
      return;
    }
    try {
      prefs(getContext()).edit().remove(key).apply();
      call.resolve(result);
    } catch (Exception e) {
      keystoreFailed = true;
      result.put("error", ERR_STORAGE);
      call.resolve(result);
    }
  }

  @PluginMethod
  public void nativeSessionGet(PluginCall call) {
    call.resolve(new JSObject().put("unlocked", sessionUnlocked));
  }

  @PluginMethod
  public void nativeSessionSet(PluginCall call) {
    sessionUnlocked = Boolean.TRUE.equals(call.getBoolean("unlocked", false));
    call.resolve(new JSObject().put("unlocked", sessionUnlocked));
  }

  /** 当前控制台的凭证键：由 current-console 的 origin 取 host（含端口）；没有当前控制台返回 null。 */
  static String currentTokenKey(SharedPreferences prefs) {
    String origin = prefs.getString(KEY_CURRENT_CONSOLE, null);
    if (origin == null || origin.isEmpty()) return null;
    try {
      String host = new URI(origin).getRawAuthority();
      if (host == null || host.isEmpty()) return null;
      String key = host + TOKEN_SUFFIX;
      return TOKEN_KEY.matcher(key).matches() ? key : null;
    } catch (Exception e) {
      return null;
    }
  }

  /**
   * 供下载插件从同一份安全存储读取设备令牌：优先当前控制台（按 host 分 key）的凭证，
   * 没有多控制台记录时回退旧单凭证键；Keystore 异常时返回 null，不发带错令牌的请求。
   */
  static String readToken(Context context) throws Exception {
    if (context == null) return null;
    // Keystore 已废的设备读不了加密文件：改从兜底存储按同一键规则取，绝不带错令牌发请求。
    SharedPreferences store;
    try {
      store = prefs(context);
    } catch (Exception keystoreBroken) {
      store = plain(context);
    }
    String key = currentTokenKey(store);
    if (key != null) return store.getString(key, null);
    return store.getString(KEY_DEVICE_TOKEN, null);
  }

  private static SharedPreferences plain(Context context) {
    return context.getSharedPreferences(PREFS_FALLBACK_NAME, Context.MODE_PRIVATE);
  }

  private static String readPlain(Context context, String key) {
    if (context == null || key == null) return null;
    try { return plain(context).getString(key, null); } catch (Exception ignored) { return null; }
  }

  private static void writePlain(Context context, String key, String value) {
    if (context == null || key == null) return;
    try { plain(context).edit().putString(key, value).apply(); } catch (Exception ignored) { /* 兜底也失败只丢持久化 */ }
  }

  private static void removePlain(Context context, String key) {
    if (context == null || key == null) return;
    try { plain(context).edit().remove(key).apply(); } catch (Exception ignored) { }
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
