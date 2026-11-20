package cool.autoloop.console.auth;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 生物识别插件空实现：native-auth 节点填 verify 的系统调用，不改注册点。 */
@CapacitorPlugin(name = "AutoloopBiometric")
public class AutoLoopBiometric extends Plugin {
  @PluginMethod
  public void verify(PluginCall call) {
    call.resolve(new JSObject().put("ok", false));
  }
}
