/// <reference types="node" />
import { TextEncoder, TextDecoder } from 'node:util';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { AESEncryptionKey, AESSealedData, aesEncryptAsync, aesDecryptAsync } from 'expo-crypto';
import { createNativeJournal, nativeJournalCipher, nativeJournalKeys } from '../src/chat/journal/native';
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6 }));
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('expo-crypto', () => ({ AESEncryptionKey: { generate: jest.fn(), import: jest.fn() }, AESSealedData: { fromCombined: jest.fn() }, AESKeySize: { AES256: 256 }, aesEncryptAsync: jest.fn(), aesDecryptAsync: jest.fn(), randomUUID: () => 'installation-uuid' }));
beforeEach(() => { jest.clearAllMocks(); Object.assign(globalThis, { TextEncoder, TextDecoder }); });
const key = { installationId: 'install-1', secret: 'A'.repeat(43) + '=' };
it('uses native AES256 generation, device-only SecureStore, authenticated combined envelopes and strict key parsing', async () => {
    jest.mocked(AESEncryptionKey.generate).mockResolvedValue({ size: 256, bytes: async () => new Uint8Array(32), encoded: async () => key.secret } as AESEncryptionKey);
    expect(await nativeJournalKeys.create(key.installationId)).toEqual(key);
    expect(AESEncryptionKey.generate).toHaveBeenCalledWith(256);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('pairspace.chat.journal.key.v1', JSON.stringify(key), expect.objectContaining({ keychainAccessible: 6 }));
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify(key));
    expect(await nativeJournalKeys.read()).toEqual(key);
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    expect(await nativeJournalKeys.read()).toBeNull();
    for (const raw of ['x'.repeat(1025), '{', '{}', 'null', JSON.stringify({ ...key, secret: 'bad' }), JSON.stringify({ ...key, installationId: '' })]) {
        jest.mocked(SecureStore.getItemAsync).mockResolvedValue(raw);
        await expect(nativeJournalKeys.read()).rejects.toThrow('locked');
    }
    await nativeJournalKeys.remove();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
    jest.mocked(AESEncryptionKey.import).mockResolvedValue({} as AESEncryptionKey);
    jest.mocked(aesEncryptAsync).mockResolvedValue({ combined: async () => 'opaque-cipher' } as AESSealedData);
    expect(await nativeJournalCipher.seal('Private', key, 'scope-aad')).toEqual({ data: 'opaque-cipher' });
    expect(aesEncryptAsync).toHaveBeenCalledWith(expect.any(Uint8Array), expect.anything(), { additionalData: expect.any(Uint8Array), nonce: { length: 12 }, tagLength: 16 });
    jest.mocked(AESSealedData.fromCombined).mockReturnValue({} as AESSealedData);
    jest.mocked(aesDecryptAsync).mockResolvedValue(new Uint8Array([80, 114, 105, 118, 97, 116, 101]));
    expect(await nativeJournalCipher.open({ data: 'cipher' }, key, 'scope-aad')).toBe('Private');
    expect(AESSealedData.fromCombined).toHaveBeenCalledWith('cipher', { ivLength: 12, tagLength: 16 });
});
it('web is unsupported without opening SQLite; native factory requests isolated connection and reports init failure', async () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const unsupported = await createNativeJournal();
    expect(await unsupported.reset()).toEqual({ ok: false, error: 'unsupported' });
    unsupported.suspend({ installationId: 'x', generation: 1, lease: 1, scope: 'x' });
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const db = { execAsync: jest.fn(async () => { }), getFirstAsync: jest.fn(async (sql: string) => sql.includes('journal_mode') ? { journal_mode: 'wal' } : sql.includes('synchronous') ? { synchronous: 2 } : { foreign_keys: 1 }), runAsync: jest.fn(), closeAsync: jest.fn(async () => { }) };
    jest.mocked(SQLite.openDatabaseAsync).mockResolvedValue(db as unknown as SQLite.SQLiteDatabase);
    expect(await createNativeJournal()).toHaveProperty('prepareSend');
    expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith('pairspace-chat-journal-v1.db', { useNewConnection: true });
    jest.mocked(SQLite.openDatabaseAsync).mockRejectedValue(Error('unavailable'));
    await expect(createNativeJournal()).rejects.toThrow('unavailable');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: original });
});
