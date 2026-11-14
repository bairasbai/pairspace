import { Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { AESEncryptionKey, AESSealedData, AESKeySize, aesEncryptAsync, aesDecryptAsync, randomUUID } from 'expo-crypto';
import { createJournal } from './engine';
import { createSQLiteJournalStore } from './sqlite-store';
import type { JournalCipher, JournalKey, JournalKeys, JournalPort } from './types';
import { identifier, JournalFault } from './validation';
const keyName = 'pairspace.chat.journal.key.v1';
const keyOptions = { keychainService: 'pairspace.chat.journal.v1', keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const nativeJournalCipher: JournalCipher = {
    async seal(plaintext, key, aad) {
        const secret = await AESEncryptionKey.import(key.secret, 'base64');
        const sealed = await aesEncryptAsync(new TextEncoder().encode(plaintext), secret, {
            additionalData: new TextEncoder().encode(aad), nonce: { length: 12 }, tagLength: 16,
        });
        return { data: await sealed.combined('base64') };
    },
    async open(envelope, key, aad) {
        const secret = await AESEncryptionKey.import(key.secret, 'base64');
        const sealed = AESSealedData.fromCombined(envelope.data, { ivLength: 12, tagLength: 16 });
        const bytes = await aesDecryptAsync(sealed, secret, { additionalData: new TextEncoder().encode(aad) });
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    },
};
export const nativeJournalKeys: JournalKeys = {
    async read() {
        const raw = await SecureStore.getItemAsync(keyName, keyOptions);
        if (raw === null)
            return null;
        try {
            if(raw.length>1024)throw new Error('invalid_key');
            const key: unknown = JSON.parse(raw);
            if (!key || typeof key !== 'object' || Array.isArray(key) || Object.keys(key).sort().join(',') !== 'installationId,secret'
                || !('installationId' in key) || !identifier(key.installationId) || !('secret' in key) || typeof key.secret !== 'string'
                || !/^[A-Za-z0-9+/]{43}=$/.test(key.secret))
                throw new Error('invalid_key');
            return key as JournalKey;
        }
        catch {
            throw new JournalFault('locked');
        }
    },
    async create(installationId) {
        // Native AES key generation, not development-mode random-byte fallbacks.
        const native = await AESEncryptionKey.generate(AESKeySize.AES256);
        const key = { installationId, secret: await native.encoded('base64') };
        await SecureStore.setItemAsync(keyName, JSON.stringify(key), keyOptions);
        return key;
    },
    async remove() { await SecureStore.deleteItemAsync(keyName, keyOptions); },
};
export function unsupportedJournal(): JournalPort {
    const unsupported = async () => ({ ok: false as const, error: 'unsupported' as const });
    return { bindVerifiedScope: unsupported, inspect: unsupported, restore: unsupported, saveDraft: unsupported,
        prepareSend: unsupported, settlePending: unsupported, discardPending: unsupported, retire: unsupported, reset: unsupported, suspend() { } };
}
/** Experimental opt-in caller only. Web must never silently fall back to plaintext storage. */
export async function createNativeJournal(): Promise<JournalPort> {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android')
        return unsupportedJournal();
    const store = await createSQLiteJournalStore(() => SQLite.openDatabaseAsync('pairspace-chat-journal-v1.db', { useNewConnection: true }));
    return createJournal({ store, keys: nativeJournalKeys, cipher: nativeJournalCipher, randomId: randomUUID });
}
