package cool.autoloop.console.auth;

import android.webkit.DownloadListener;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 下载接缝：H5 一律调用 AutoloopDownload.start；DownloadListener 只作兜底，不做普通链接跳转。 */
@CapacitorPlugin(name = "AutoloopDownload")
public class AutoLoopDownloads extends Plugin {
  @PluginMethod
  public void start(PluginCall call) {
    call.resolve(new JSObject().put("started", false));
  }

  /** 兜底监听器：避免系统下载走不带 x-device-token 的普通跳转。 */
  public static final class DownloadBridge implements DownloadListener {
    @Override
    public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
      // 空实现：后续节点在此接原生下载管理器。
    }
  }
}
