package cool.autoloop.console.auth;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 安全存储插件空实现：设备凭证只放 Android Keystore，不写 localStorage 或日志。 */
@CapacitorPlugin(name = "AutoloopSecureStorage")
public class AutoLoopSecureStorage extends Plugin {
  @PluginMethod
  public void get(PluginCall call) { call.resolve(); }

  @PluginMethod
  public void set(PluginCall call) { call.resolve(); }

  @PluginMethod
  public void remove(PluginCall call) { call.resolve(); }
}
