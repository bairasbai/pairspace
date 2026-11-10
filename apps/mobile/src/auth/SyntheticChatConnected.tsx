import { useSyncExternalStore } from 'react';
import { ScrollView } from 'react-native';
import { SyntheticChatPanel } from './SyntheticChatPanel';
import type { createSessionController } from './controller';
import type { Locale } from '../copy';
export type SessionController = ReturnType<typeof createSessionController>;
export function SyntheticChatConnected({ controller, locale }: { controller: SessionController; locale: Locale }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }}>
    <SyntheticChatPanel {...view} locale={locale}
    onDraft={controller.setDraft} onSignIn={(email, password) => { void controller.signIn(email, password); }}
    onSignOut={() => { void controller.signOut(); }} onSend={() => { void controller.send(); }}
    onCreateWaitingSpace={() => { void controller.createWaitingSpace(); }}
    onCreateProfile={() => { void controller.createProfile(); }}
    onRefresh={() => { void controller.refresh(); }} />
  </ScrollView>;
}
