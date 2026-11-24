// 产物快照装配（DAG 节点 artifacts-sync）：把「会话快照 + 各会话只读产物响应」装配成
// 全局聚合列表与单会话列表。纯逻辑：不碰 DOM、不发请求、不依赖 node: 内置模块；
// 取数与设备凭证由页面模块负责，这里只输出可 JSON 化的纯数据。

const str = value => String(value ?? '');
const arr = value => (Array.isArray(value) ? value : []);
const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 只保留服务端只读列表的元数据；会话/任务由所属会话补齐，不保留任何文件内容。
export function normalizeArtifactFile(raw, { sessionId, task } = {}) {
  const source = isObj(raw) ? raw : {};
  const relPath = str(source.path);
  return {
    id: str(source.id || `${str(sessionId)}:${relPath}`),
    path: relPath,
    name: str(source.name || relPath.split(/[\\/]/).pop() || relPath),
    size: Math.max(0, Number(source.size) || 0),
    at: str(source.at),
    sessionId: str(source.sessionId ?? sessionId),
    task: str(source.task ?? task),
  };
}

// sessions 来自控制台会话快照 [{ id, task }]；responses 为 { [sessionId]: { files } | { error } }。
// 单会话读取失败只记 error 并保留其他分组；全部失败时 artifacts 为空但 allFailed 为真，
// 页面据此给明确空态，绝不编造产物。
export function buildSessionArtifactsSnapshot(sessions = [], responses = {}) {
  const groups = [];
  const seen = new Set();
  for (const session of arr(sessions)) {
    if (!isObj(session)) continue;
    const sessionId = str(session.id);
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const task = str(session.task);
    const response = isObj(responses) ? responses[sessionId] : null;
    if (isObj(response) && typeof response.error === 'string' && response.error) {
      groups.push({ sessionId, task, files: [], error: response.error });
      continue;
    }
    groups.push({
      sessionId, task, error: null,
      files: arr(isObj(response) ? response.files : null)
        .map(file => normalizeArtifactFile(file, { sessionId, task })),
    });
  }
  const artifacts = groups
    .flatMap(group => group.files)
    .sort((a, b) => b.at.localeCompare(a.at) || a.path.localeCompare(b.path) || a.sessionId.localeCompare(b.sessionId));
  const errors = groups.filter(group => group.error).map(group => ({ sessionId: group.sessionId, error: group.error }));
  return {
    groups, artifacts, errors,
    allFailed: groups.length > 0 && errors.length === groups.length,
  };
}

// 全局页：按会话分组聚合后的全部产物（按修改时间倒序）。
export const snapshotArtifacts = snapshot => (isObj(snapshot) ? arr(snapshot.artifacts) : []);

// 会话入口：只取该会话分组的产物列表。
export function snapshotSessionArtifacts(snapshot, sessionId) {
  const target = str(sessionId);
  const group = isObj(snapshot) ? arr(snapshot.groups).find(item => str(item?.sessionId) === target) : null;
  return group ? arr(group.files) : [];
}

// 会话入口/全局页：该会话的读取失败文案；成功或未命中返回 null。
export function snapshotSessionError(snapshot, sessionId) {
  const target = str(sessionId);
  const item = isObj(snapshot) ? arr(snapshot.errors).find(entry => str(entry?.sessionId) === target) : null;
  return item ? str(item.error) : null;
}
