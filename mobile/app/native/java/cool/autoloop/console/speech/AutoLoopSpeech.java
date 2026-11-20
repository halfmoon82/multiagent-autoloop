package cool.autoloop.console.speech;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 语音插件空实现：native-speech 节点填录音与转写，H5 走 ctx.hooks.attachVoice。 */
@CapacitorPlugin(name = "AutoloopSpeech")
public class AutoLoopSpeech extends Plugin {
  @PluginMethod
  public void start(PluginCall call) { call.resolve(); }

  @PluginMethod
  public void stop(PluginCall call) { call.resolve(); }
}
