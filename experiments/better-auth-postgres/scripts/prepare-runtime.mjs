import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve('node_modules/@embedded-postgres/linux-x64');
const entries = JSON.parse(await fs.readFile(path.join(root, 'native/pg-symlinks.json'), 'utf8'));
if (!Array.isArray(entries)) throw new Error('Invalid symlink manifest');
for (const entry of entries) {
  for (const key of ['source', 'target']) {
    if (typeof entry[key] !== 'string') throw new Error('Invalid symlink entry');
    const resolved = path.resolve(root, entry[key]);
    if (!resolved.startsWith(root + path.sep)) throw new Error('Symlink escapes package');
  }
}
const { hydrateSymlinks } = await import(pathToFileURL(path.join(root, 'scripts/hydrate-symlinks.js')).href);
await hydrateSymlinks();
for (const entry of entries) {
  const target = await fs.realpath(path.resolve(root, entry.target));
  if (!target.startsWith(root + path.sep)) throw new Error('Hydrated symlink escapes package');
}
console.log(`Verified ${entries.length} package-local runtime symlinks`);
