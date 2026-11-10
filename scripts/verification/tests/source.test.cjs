const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { snapshot, sourceMatches } = require('../source.cjs');
let root;
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root });
  if (result.status) throw new Error('git fixture failed');
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-source-test-'));
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'source.txt'), 'source');
  fs.symlinkSync('source.txt', path.join(root, 'link'));
  git('add', '.'); git('commit', '-qm', 'fixture');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
test('captures clean source SHA/tree and bytes, rejects dirty baseline and changes', () => {
  const before = snapshot(root); expect(before.dirty).toBe(false);
  expect(before.files.find(file => file.path === 'link').symlink).toBe(true);
  expect(sourceMatches(before, snapshot(root))).toBe(true);
  fs.writeFileSync(path.join(root, 'source.txt'), 'changed');
  const after = snapshot(root);
  expect(sourceMatches(before, after)).toBe(false); expect(sourceMatches(after, after)).toBe(false);
  expect(before.trackedHash).not.toBe(after.trackedHash);
});
test('untracked source, deleted tracked file and invalid repository cannot pass', () => {
  fs.writeFileSync(path.join(root, 'new.js'), 'untracked'); expect(snapshot(root).dirty).toBe(true);
  fs.unlinkSync(path.join(root, 'source.txt')); expect(() => snapshot(root)).toThrow();
  expect(() => snapshot('/nonexistent-pairspace-dir')).toThrow('SOURCE_GIT_FAILED');
});
test('commit, tree, or content identity change invalidates clean report', () => {
  const before = snapshot(root);
  for (const field of ['sha', 'tree', 'trackedHash']) expect(sourceMatches(before, { ...before, [field]: 'different' })).toBe(false);
});

test('hidden index flags cannot turn modified source into an exact-commit PASS', () => {
  const before = snapshot(root);
  git('update-index', '--assume-unchanged', 'source.txt');
  fs.writeFileSync(path.join(root, 'source.txt'), 'hidden modification');
  expect(snapshot(root).dirty).toBe(true);
  expect(sourceMatches(before, snapshot(root))).toBe(false);
  git('update-index', '--no-assume-unchanged', 'source.txt');
  git('checkout', '--', 'source.txt');
  git('update-index', '--skip-worktree', 'source.txt');
  fs.writeFileSync(path.join(root, 'source.txt'), 'hidden worktree modification');
  expect(snapshot(root).dirty).toBe(true);
});
test('executable bit and staged additions differ from HEAD identity', () => {
  fs.chmodSync(path.join(root, 'source.txt'), 0o755); expect(snapshot(root).dirty).toBe(true);
  fs.writeFileSync(path.join(root, 'new.txt'), 'added'); git('add', 'new.txt');
  expect(snapshot(root).files.find(file => file.path === 'new.txt').matchesHead).toBe(false);
});
