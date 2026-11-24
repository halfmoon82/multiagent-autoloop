package cool.autoloop.console.notify;

/**
 * App 前后台与「当前所在会话详情」的进程内标记，供前台服务判断会话新回复是否需要推送：
 * 仅 App 在后台、或前台但不在该会话详情页时才推送。
 */
final class AppVisibility {
  private static volatile boolean foreground = false;
  private static volatile String activeSessionId = "";

  private AppVisibility() {}

  static void setForeground(boolean value) { foreground = value; }

  static boolean isForeground() { return foreground; }

  static void setActiveSession(String id) { activeSessionId = id == null ? "" : id; }

  /** 会话 sessionId 的新回复是否应当推送系统通知。 */
  static boolean shouldPushSession(String sessionId) {
    if (!foreground) return true;
    return activeSessionId.isEmpty() || !activeSessionId.equals(sessionId);
  }
}
