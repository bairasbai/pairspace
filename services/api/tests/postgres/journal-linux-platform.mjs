import { Buffer } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Test platform adapters only. Real Linux SQLite and AES-GCM, NOT Expo/native
 * SecureStore, device hardware keystore, or a native-process durability claim. */
export async function linuxJournalPlatform(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'journal.sqlite'), vault = path.join(directory, 'synthetic-vault.json');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS journal (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL)');
  let tail = Promise.resolve(), failCommit = false, opens = 0;
  const store = { transaction(work) {
    const run = tail.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      let wrote = false;
      try {
        const result = await work({
          async read() { const row = db.prepare('SELECT value FROM journal WHERE singleton=1').get(); return row ? JSON.parse(row.value) : null; },
          async write(row) { wrote = true; db.prepare('INSERT INTO journal(singleton,value) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value').run(JSON.stringify(row)); },
        });
        if (failCommit && wrote) { failCommit = false; throw Error('synthetic commit failure'); }
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    tail = run.catch(() => {}); return run;
  } };
  const keyProvider = {
    async read() { try { return JSON.parse(await readFile(vault, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    async create(installationId) {
      const key = { installationId, secret: randomBytes(32).toString('base64') };
      await writeFile(`${vault}.new`, JSON.stringify(key), { mode: 0o600 }); await rename(`${vault}.new`, vault); return key;
    },
    async remove() { try { await unlink(vault); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
  };
  const importKey = key => webcrypto.subtle.importKey('raw', Buffer.from(key.secret, 'base64'), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const cipher = {
    async seal(plaintext, key, aad) {
      const iv = randomBytes(12);
      const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(aad), tagLength: 128 }, await importKey(key), Buffer.from(plaintext));
      return { data: Buffer.concat([iv, Buffer.from(encrypted)]).toString('base64') };
    },
    async open(sealed, key, aad) {
      opens++; const combined = Buffer.from(sealed.data, 'base64');
      if (combined.length < 28) throw Error('invalid synthetic cipher envelope');
      const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.subarray(0, 12), additionalData: Buffer.from(aad), tagLength: 128 }, await importKey(key), combined.subarray(12));
      return Buffer.from(plaintext).toString('utf8');
    },
  };
  return { store, keyProvider, cipher, filename, vault, stats: () => ({ opens }),
    failNextCommit() { failCommit = true; },
    async close() { await tail; db.close(); },
  };
}
