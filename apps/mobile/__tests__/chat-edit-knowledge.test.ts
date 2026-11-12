/// <reference types="node" />
import { createHash, webcrypto } from 'node:crypto';
import { createEditKnowledge, webBodyDigest } from '../src/chat/edit-knowledge';
import { row } from './chat-window.fixture';
const digest = async (body: string) => createHash('sha256').update(body).digest('hex');
const edit = (n: number, version = 2) => ({ ...row(n), version, body: `edited${n}` });
async function accept(k: ReturnType<typeof createEditKnowledge>, messages: ReturnType<typeof edit>[]) { const t = await k.prepare(messages); if (!t || !t.isCurrent())
    return false; t.commit(); return true; }
it('v1 consumes no floor, higher versions replace; equal contradiction and lower version fail without plaintext retention', async () => {
    const k = createEditKnowledge(digest);
    expect(await accept(k, [row(1)])).toBe(true);
    expect(k.size()).toBe(0);
    expect(await accept(k, [edit(1)])).toBe(true);
    expect(await accept(k, [edit(1)])).toBe(true);
    expect(await accept(k, [row(1)])).toBe(false);
    expect(await accept(k, [{ ...edit(1), body: 'contradictory' }])).toBe(false);
    expect(await accept(k, [{ ...edit(1), senderId: row(2).id }])).toBe(false);
    expect(await accept(k, [edit(1, 3)])).toBe(true);
    expect(k.size()).toBe(1);
});
it('500 edited targets never evict, 501 refuses atomically; fresh auth reset clears metadata', async () => {
    const k = createEditKnowledge(digest);
    expect(await accept(k, Array.from({ length: 500 }, (_, i) => edit(i + 1)))).toBe(true);
    await expect(k.prepare([edit(501)])).rejects.toThrow('edit_knowledge_limit');
    expect(k.size()).toBe(500);
    expect(await accept(k, [row(1)])).toBe(false);
    k.reset();
    expect(k.size()).toBe(0);
    expect(await accept(k, [row(1)])).toBe(true);
});
it('held hash cannot commit across reset or overwrite concurrently committed newer floor', async () => {
    let release!: (hash: string) => void;
    const k = createEditKnowledge(() => new Promise(resolve => { release = resolve; }));
    const held = k.prepare([edit(1)]);
    k.reset();
    release(await digest(edit(1).body));
    expect(await held).toBeNull();
    const fresh = createEditKnowledge(digest);
    const a = await fresh.prepare([edit(1)]);
    expect(a).not.toBeNull();
    expect(await accept(fresh, [edit(1, 3)])).toBe(true);
    expect(a!.isCurrent()).toBe(false);
});
it('rejects malformed crypto output, trusts official SHA256 implementation', async () => {
    await expect(createEditKnowledge(async () => 'weak').prepare([edit(1)])).rejects.toThrow('invalid_digest');
    const old = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    try {
        expect(await webBodyDigest('hello')).toBe(await digest('hello'));
    }
    finally {
        if (old)
            Object.defineProperty(globalThis, 'crypto', old);
        else
            Reflect.deleteProperty(globalThis, 'crypto');
    }
});
