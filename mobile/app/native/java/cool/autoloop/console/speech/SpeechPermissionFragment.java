package cool.autoloop.console.speech;

import android.content.pm.PackageManager;

import androidx.fragment.app.Fragment;
import androidx.fragment.app.FragmentActivity;

/**
 * headless Fragment：让 speech 插件在不改 MainActivity 的前提下申请 RECORD_AUDIO 运行时权限，
 * 并接收结果。Capacitor 的 BridgeActivity 继承 AppCompatActivity（即 FragmentActivity）。
 */
public final class SpeechPermissionFragment extends Fragment {
  public interface PermissionCallback {
    void onResult(boolean granted);
  }

  private static final String TAG = "autoloop-speech-permission-fragment";

  private PermissionCallback permissionCallback;

  /** 同一 Activity 复用一个 headless Fragment，避免重复添加。 */
  static SpeechPermissionFragment attach(FragmentActivity activity) {
    SpeechPermissionFragment fragment =
        (SpeechPermissionFragment) activity.getSupportFragmentManager().findFragmentByTag(TAG);
    if (fragment == null) {
      fragment = new SpeechPermissionFragment();
      activity.getSupportFragmentManager().beginTransaction().add(fragment, TAG).commitNow();
    }
    return fragment;
  }

  void requestRuntimePermissions(String[] permissions, int requestCode, PermissionCallback callback) {
    this.permissionCallback = callback;
    requestPermissions(permissions, requestCode);
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
}
