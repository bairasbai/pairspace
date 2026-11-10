import { LeavePanel } from './LeavePanel';
import { LettersPanel } from './LettersPanel';
import { useEffect, useSyncExternalStore } from 'react';
import { ScrollView } from 'react-native';
import { CarePanel } from './CarePanel';
import { SyntheticChatPanel } from './SyntheticChatPanel';
import type { createSessionController } from './controller';
import type { Locale } from '../copy';
export type SessionController = ReturnType<typeof createSessionController>;
export function SyntheticChatConnected({ controller, locale, ownsController = true, showCareSend = true }: { controller: SessionController; locale: Locale; ownsController?: boolean; showCareSend?: boolean }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const leave = controller.leave;
  const leaveView = useSyncExternalStore(leave.subscribe, leave.getSnapshot);
  const letters = controller.letters;
  const lettersView = useSyncExternalStore(letters.subscribe, letters.getSnapshot);
  const care = controller.care;
  const careView = useSyncExternalStore(care.subscribe, care.getSnapshot);
  const invitations = controller.invitations;
  const inviteView = useSyncExternalStore(invitations.subscribe, invitations.getSnapshot);
  useEffect(() => ownsController ? () => controller.dispose() : undefined, [controller, ownsController]);
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }}>
    <LeavePanel locale={locale} view={leaveView} onBegin={leave.begin} onCancel={leave.cancel} onConfirm={() => { void leave.confirm(); }} />
    <LettersPanel locale={locale} view={lettersView} onDraft={letters.setDraft}
      onReleaseAt={letters.setReleaseAt} onReleaseTimezone={letters.setReleaseTimezone}
      onSendLater={() => { void letters.sendLater(); }} onSend={() => { void letters.send(); }} onList={() => { void letters.list(); }}
      onOpen={id => { void letters.open(id); }} onClose={letters.close} />
    <CarePanel showSend={showCareSend} locale={locale} view={careView} onSend={() => { void care.send(); }} onRead={() => { void care.read(); }} />
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
