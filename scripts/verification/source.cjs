'use strict';
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, readlinkSync } = require('node:fs');
const path = require('node:path');
const digest = data => createHash('sha256').update(data).digest('hex');
function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root, encoding: 'utf8', shell: false, timeout: 10000, maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('SOURCE_GIT_FAILED');
  return result.stdout;
}
function snapshot(root) {
  const sha = git(root, ['rev-parse', 'HEAD']).trim();
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const head = new Map(git(root, ['ls-tree', '-rz', '--full-tree', 'HEAD']).split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    if (type !== 'blob') throw new Error('UNSUPPORTED_SOURCE_ENTRY');
    return [entry.slice(tab + 1), { mode, oid }];
  }));
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean).map(name => {
    const filename = path.resolve(root, name);
    if (!filename.startsWith(root + path.sep)) throw new Error('SOURCE_PATH_ESCAPE');
    const stat = lstatSync(filename);
    const content = stat.isSymbolicLink() ? readlinkSync(filename) : readFileSync(filename);
    const bytes = Buffer.from(content);
    const expected = head.get(name);
    const blob = createHash(sha.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
    const matchesHead = expected?.oid === blob && expected.mode === mode;
    return { matchesHead, path: name, sha256: digest(content), mode: stat.mode & 0o777, symlink: stat.isSymbolicLink() };
  });
  return { sha, tree, dirty: status.length !== 0 || files.length !== head.size || files.some(file => !file.matchesHead), statusHash: digest(status),
    trackedHash: digest(JSON.stringify(files)), files };
}
function sourceMatches(before, after) {
  return !before.dirty && !after.dirty && before.sha === after.sha
    && before.tree === after.tree && before.trackedHash === after.trackedHash;
}
module.exports = { snapshot, sourceMatches };
