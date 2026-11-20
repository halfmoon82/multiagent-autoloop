package cool.autoloop.console.auth;

import android.content.Intent;
import android.content.pm.PackageManager;

import androidx.fragment.app.Fragment;
import androidx.fragment.app.FragmentActivity;

/**
 * headless Fragment：让 WebChromeClient 在不改 MainActivity 的前提下接收运行时权限结果与
 * 文件选择器结果。Capacitor 的 BridgeActivity 继承 AppCompatActivity（即 FragmentActivity）。
 */
public final class AutoLoopHostFragment extends Fragment {
  public interface PermissionCallback {
    void onResult(boolean granted);
  }

  public interface ActivityResultCallback {
    void onResult(int resultCode, Intent data);
  }

  private static final String TAG = "autoloop-host-fragment";

  private PermissionCallback permissionCallback;
  private ActivityResultCallback activityResultCallback;

  /** 同一 Activity 复用一个 headless Fragment，避免重复添加。 */
  public static AutoLoopHostFragment attach(FragmentActivity activity) {
    AutoLoopHostFragment fragment =
        (AutoLoopHostFragment) activity.getSupportFragmentManager().findFragmentByTag(TAG);
    if (fragment == null) {
      fragment = new AutoLoopHostFragment();
      activity.getSupportFragmentManager().beginTransaction().add(fragment, TAG).commitNow();
    }
    return fragment;
  }

  public void requestRuntimePermissions(String[] permissions, int requestCode, PermissionCallback callback) {
    this.permissionCallback = callback;
    requestPermissions(permissions, requestCode);
  }

  public void launchForResult(Intent intent, int requestCode, ActivityResultCallback callback) {
    this.activityResultCallback = callback;
    startActivityForResult(intent, requestCode);
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    PermissionCallback callback = this.permissionCallback;
    this.permissionCallback = null;
    if (callback == null) return;
    boolean granted = grantResults != null && grantResults.length > 0;
    if (granted) {
      for (int result : grantResults) {
        if (result != PackageManager.PERMISSION_GRANTED) {
          granted = false;
          break;
        }
      }
    }
    callback.onResult(granted);
  }

  @Override
  public void onActivityResult(int requestCode, int resultCode, Intent data) {
    ActivityResultCallback callback = this.activityResultCallback;
    this.activityResultCallback = null;
    if (callback != null) callback.onResult(resultCode, data);
  }
}
