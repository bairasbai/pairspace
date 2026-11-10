import { useEffect, useSyncExternalStore } from 'react';
import { ScrollView } from 'react-native';
import { SyntheticChatPanel } from './SyntheticChatPanel';
import type { createSessionController } from './controller';
import type { Locale } from '../copy';
export type SessionController = ReturnType<typeof createSessionController>;
export function SyntheticChatConnected({ controller, locale }: { controller: SessionController; locale: Locale }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const invitations = controller.invitations;
  const inviteView = useSyncExternalStore(invitations.subscribe, invitations.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }}>
    <SyntheticChatPanel {...view} locale={locale}
    invitations={{ view: inviteView,
      onRead: () => { void invitations.readMetadata(); }, onIssue: () => { void invitations.issue(); },
      onRevoke: () => { void invitations.revoke(); }, onToken: invitations.setToken,
      onPreview: () => { void invitations.preview(); }, onConsent: invitations.setConsent,
      onAccept: () => { void invitations.accept(); }, onCancel: invitations.cancel,
    }}
    onDraft={controller.setDraft} onSignIn={(email, password) => { void controller.signIn(email, password); }}
    onSignOut={() => { void controller.signOut(); }} onSend={() => { void controller.send(); }}
    onCreateWaitingSpace={() => { void controller.createWaitingSpace(); }}
    onCreateProfile={() => { void controller.createProfile(); }}
    onLoadOlder={() => { void controller.loadOlder(); }}
    onRefresh={() => { void controller.refresh(); }} />
  </ScrollView>;
}
