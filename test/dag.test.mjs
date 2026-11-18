import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDag, readyNodes, dependencyClosure, parallelShape,
  dependencyGraph, dependencyGraphDigest, writeScopeOverlap,
} from '../src/dag.mjs';

const node = (id, over = {}) => ({
  id, title: id, status: 'planned', depends_on: [], integration_after: [],
  contract: { input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'a', files: [`src/${id}.mjs`] },
  ...over,
});

test('validateDag rejects duplicate ids, unknown dependencies, cycles and invalid ids', () => {
  assert.match(validateDag([node('a'), node('a')]).errors.join('\n'), /唯一/);
  assert.match(validateDag([node('a', { depends_on: ['ghost'] })]).errors.join('\n'), /未知依赖/);
  assert.match(validateDag([node('a', { depends_on: ['b'] }), node('b', { depends_on: ['a'] })]).errors.join('\n'), /环/);
  assert.match(validateDag([node('节点 A')]).errors.join('\n'), /kebab-case/);
});

test('validateDag requires the four contract elements and relative file scopes', () => {
  const missing = node('a', { contract: { input: '', output: 'o', error_behavior: 'e', acceptance_example: 'a', files: ['src/a.ts'] } });
  assert.match(validateDag([missing]).errors.join('\n'), /契约/);
  const escaping = node('a', { contract: { ...node('a').contract, files: ['../outside.ts'] } });
  assert.match(validateDag([escaping]).errors.join('\n'), /项目相对路径/);
});

test('write scope overlaps must be serialized by depends_on', () => {
  const a = node('a', { contract: { ...node('a').contract, files: ['src/shared.ts'] } });
  const b = node('b', { contract: { ...node('b').contract, files: ['src/shared.ts'] } });
  assert.match(validateDag([a, b]).errors.join('\n'), /写范围重叠/);
  assert.equal(validateDag([a, { ...b, depends_on: ['a'] }]).valid, true);
  assert.equal(validateDag([{ ...b, depends_on: ['a'] }, a]).valid, true, '依赖方向不影响判定');
});

test('write scope overlaps are serialized by a transitive dependency too', () => {
  const shared = { contract: { ...node('x').contract, files: ['src/shared.ts'] } };
  const a = node('a', shared);
  const mid = node('mid', { depends_on: ['a'] });
  const far = node('far', { depends_on: ['mid'], ...shared });
  // a → mid → far：a 与 far 永不同时运行，不需要额外的直接依赖。
  assert.equal(validateDag([a, mid, far]).valid, true);
  // 兄弟节点（同一父下并行）仍必须显式串行。
  const sibling = node('sibling', { depends_on: ['mid'], ...shared });
  assert.match(validateDag([a, mid, far, sibling]).errors.join('\n'), /写范围重叠/);
});

test('writeScopeOverlap compares directory prefixes literally', () => {
  assert.equal(writeScopeOverlap('src/a', 'src/a/b.ts'), true);
  assert.equal(writeScopeOverlap('src/a.ts', 'src/ab.ts'), false);
});

test('readyNodes treats only merged done dependencies as accepted and ignores integration_after', () => {
  const nodes = [
    node('a'), node('b'), node('c', { depends_on: ['a', 'b'] }), node('d', { integration_after: ['a'] }),
  ];
  assert.deepEqual(readyNodes(nodes).map(n => n.id), ['a', 'b', 'd']);
  nodes[0].status = 'in_review';
  assert.deepEqual(readyNodes(nodes).map(n => n.id), ['a', 'b', 'd'].filter(id => id !== 'a'));
  assert.equal(readyNodes(nodes).some(n => n.id === 'c'), false);
  nodes[0].status = 'done'; nodes[1].status = 'done';
  assert.equal(readyNodes(nodes).some(n => n.id === 'c'), true);
});

test('blocked dependency closures do not suppress unrelated ready nodes', () => {
  const nodes = [node('a'), node('x', { status: 'blocked' }), node('y', { depends_on: ['x'] }), node('z')];
  assert.deepEqual([...dependencyClosure(nodes, ['x'])].sort(), ['x', 'y']);
  assert.deepEqual(readyNodes(nodes, { blockedIds: ['x'] }).map(n => n.id), ['a', 'z']);
});

test('parallelShape and dependencyGraph expose waves, width, critical path and stable digest', () => {
  const nodes = [node('a'), node('b'), node('c', { depends_on: ['a'] }), node('d', { depends_on: ['b', 'c'] })];
  assert.deepEqual(parallelShape(nodes), { parallelWaves: [['a', 'b'], ['c'], ['d']], maxParallelWidth: 2, criticalPathLength: 3 });
  const graph = dependencyGraph(nodes);
  assert.equal(graph.maxParallelWidth, 2);
  assert.deepEqual(graph.parallelWaves, [['a', 'b'], ['c'], ['d']]);
  assert.equal(dependencyGraphDigest(graph), dependencyGraphDigest(dependencyGraph(nodes)));
  assert.throws(() => dependencyGraph([]), /没有节点/);
});

test('validateDag rejects whitespace-padded ids that would disconnect the graph and hide cycles', () => {
  // 首尾空白 trim 后通过 kebab-case 校验，但建图必须用 trim 后的 id，否则依赖边断开、环检测失效。
  const result = validateDag([
    { ...node('a', { id: ' a', depends_on: ['b'] }), contract: node('a').contract },
    node('b', { depends_on: ['a'] }),
  ]);
  assert.equal(result.valid, false, '带首尾空白的节点 id 必须被拒绝');
  assert.match(result.errors.join('\n'), /空白/);
});

test('validateDag rejects an empty node list instead of passing vacuously', () => {
  const result = validateDag([]);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /节点/);
});
