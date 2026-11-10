import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { readHistory, sendMessage } from '../src/chat.ts';
import { adapter, command, createFixture, history, principal } from './fixtures.ts';

it('keeps message and deduplication after closing and reopening the database directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pairspace-pglite-'));
  let pg: PGlite | undefined;
  try {
    pg = await createFixture(join(directory, 'data'));
    const first = await sendMessage(adapter(pg), principal, command);
    if (!first.ok) throw new Error(first.error);
    await pg.close();
    pg = new PGlite(join(directory, 'data'));
    const repeated = await sendMessage(adapter(pg), principal, command);
    expect(repeated).toEqual({ ok: true, value: { ...first.value, replay: true } });
    expect(await readHistory(adapter(pg), principal, history)).toEqual({ ok: true, value: { messages: [first.value.message], nextBeforeSeq: null } });
    expect((await pg.query('SELECT * FROM outbox_events')).rows).toHaveLength(1);
  } finally {
    await pg?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
