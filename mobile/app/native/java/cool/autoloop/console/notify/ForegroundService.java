package cool.autoloop.console.notify;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/** 前台服务声明的落地类：manifest-additions.xml 已一次写全 dataSync 类型权限与声明。 */
public class ForegroundService extends Service {
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
