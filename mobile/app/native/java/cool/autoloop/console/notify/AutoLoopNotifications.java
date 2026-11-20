package cool.autoloop.console.notify;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 通知插件空实现：native-notify 节点填角标与直复实现，H5 走 ctx.hooks.notify。 */
@CapacitorPlugin(name = "AutoloopNotifications")
public class AutoLoopNotifications extends Plugin {
  @PluginMethod
  public void setBadge(PluginCall call) { call.resolve(); }

  @PluginMethod
  public void refresh(PluginCall call) { call.resolve(); }
}
