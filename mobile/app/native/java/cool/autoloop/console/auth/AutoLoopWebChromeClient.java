package cool.autoloop.console.auth;

import android.Manifest;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import java.util.ArrayList;
import java.util.List;

/**
 * 相机/麦克风运行时权限转发 + H5 文件选择走系统选择器。
 * Capacitor 默认不把 getUserMedia 转成运行时权限，这里显式申请 CAMERA/RECORD_AUDIO，
 * 授予后回 grant，拒绝后回 JS 明确错误码，scan.mjs 无需改动即可取景。
 */
public class AutoLoopWebChromeClient extends WebChromeClient {
  public static final String JS_PERMISSION_DENIED = "AUTOLOOP_CAMERA_PERMISSION_DENIED";
  static final int REQ_CAMERA = 0x4C01;
  static final int REQ_FILE = 0x4C02;

  private PermissionRequest pendingPermission;
  private ValueCallback<Uri[]> pendingFile;

  @Override
  public void onPermissionRequest(PermissionRequest request) {
    final String[] resources = request.getResources();
    final boolean video = contains(resources, PermissionRequest.RESOURCE_VIDEO_CAPTURE);
    final boolean audio = contains(resources, PermissionRequest.RESOURCE_AUDIO_CAPTURE);
    if (!video && !audio) {
      request.deny();
      return;
    }

    FragmentActivity activity = activityOf(AutoLoopBridge.webView());
    if (activity == null) {
      denyWithCode(request);
      return;
    }

    List<String> needed = new ArrayList<>();
    if (video && ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA)
        != PackageManager.PERMISSION_GRANTED) {
      needed.add(Manifest.permission.CAMERA);
    }
    if (audio && ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      needed.add(Manifest.permission.RECORD_AUDIO);
    }
    if (needed.isEmpty()) {
      request.grant(captureResources(resources));
      return;
    }

    pendingPermission = request;
    AutoLoopHostFragment.attach(activity).requestRuntimePermissions(
        needed.toArray(new String[0]), REQ_CAMERA,
        granted -> {
          PermissionRequest pending = pendingPermission;
          pendingPermission = null;
          if (pending == null) return;
          if (granted) {
            pending.grant(captureResources(pending.getResources()));
          } else {
            denyWithCode(pending);
          }
        });
  }

  private void denyWithCode(PermissionRequest request) {
    request.deny();
    // 用户拒权给 JS 明确错误码，页面可提示去系统设置开启，不把 getUserMedia 失败吞掉。
    AutoLoopBridge.reportToJs("autoloop:permission-denied", JS_PERMISSION_DENIED,
        "相机或麦克风权限被拒绝，请在系统设置中允许后重试");
  }

  @Override
  public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams params) {
    if (pendingFile != null) pendingFile.onReceiveValue(null);
    pendingFile = filePathCallback;
    FragmentActivity activity = activityOf(webView);
    if (activity == null) {
      pendingFile.onReceiveValue(null);
      pendingFile = null;
      return false;
    }
    Intent intent;
    try {
      intent = params.createIntent();
    } catch (Exception e) {
      pendingFile.onReceiveValue(null);
      pendingFile = null;
      return false;
    }
    AutoLoopHostFragment.attach(activity).launchForResult(intent, REQ_FILE, (resultCode, data) -> {
      ValueCallback<Uri[]> callback = pendingFile;
      pendingFile = null;
      if (callback == null) return;
      Uri[] results = null;
      if (resultCode == FragmentActivity.RESULT_OK && data != null) {
        String dataString = data.getDataString();
        if (dataString != null) results = new Uri[] { Uri.parse(dataString) };
      }
      callback.onReceiveValue(results);
    });
    return true;
  }

  private static boolean contains(String[] values, String target) {
    for (String value : values) {
      if (target.equals(value)) return true;
    }
    return false;
  }

  /** 只回授予 WebView 真正要的摄像头/麦克风资源，不多授其他资源。 */
  private static String[] captureResources(String[] resources) {
    List<String> out = new ArrayList<>();
    for (String resource : resources) {
      if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
          || PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
        out.add(resource);
      }
    }
    return out.toArray(new String[0]);
  }

  private static FragmentActivity activityOf(WebView webView) {
    if (webView == null) return null;
    Context context = webView.getContext();
    while (context instanceof ContextWrapper) {
      if (context instanceof FragmentActivity) return (FragmentActivity) context;
      context = ((ContextWrapper) context).getBaseContext();
    }
    return context instanceof FragmentActivity ? (FragmentActivity) context : null;
  }
}
