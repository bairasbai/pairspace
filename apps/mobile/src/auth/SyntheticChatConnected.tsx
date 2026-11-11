import { SongsPanel } from './SongsPanel';
import { MemoriesPanel } from './MemoriesPanel';
import { DatesPanel } from './DatesPanel';
import { BlindPanel } from './BlindPanel';
import { TasksPanel } from './TasksPanel';
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
  const blind = controller.blind;
  const blindView = useSyncExternalStore(blind.subscribe, blind.getSnapshot);
  const leave = controller.leave;
  const leaveView = useSyncExternalStore(leave.subscribe, leave.getSnapshot);
  const songs = controller.songs;
  const songsView = useSyncExternalStore(songs.subscribe, songs.getSnapshot);
  const memories = controller.memories;
  const memoriesView = useSyncExternalStore(memories.subscribe, memories.getSnapshot);
  const dates = controller.dates;
  const datesView = useSyncExternalStore(dates.subscribe, dates.getSnapshot);
  const tasks = controller.tasks;
  const tasksView = useSyncExternalStore(tasks.subscribe, tasks.getSnapshot);
  const letters = controller.letters;
  const lettersView = useSyncExternalStore(letters.subscribe, letters.getSnapshot);
  const care = controller.care;
  const careView = useSyncExternalStore(care.subscribe, care.getSnapshot);
  const invitations = controller.invitations;
  const inviteView = useSyncExternalStore(invitations.subscribe, invitations.getSnapshot);
  useEffect(() => ownsController ? () => controller.dispose() : undefined, [controller, ownsController]);
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }}>
    <LeavePanel locale={locale} view={leaveView} onBegin={leave.begin} onCancel={leave.cancel} onConfirm={() => { void leave.confirm(); }} />
    <BlindPanel locale={locale} view={blindView} onDraft={blind.setDraft} onConsent={blind.setConsent}
      onList={() => { void blind.listRounds(); }} onSelect={id => { void blind.selectRound(id); }}
      onNext={(id, version, confirm) => { void blind.next(id, version, confirm); }}
      onOpen={() => { void blind.open(); }} onRead={() => { void blind.read(); }}
      onSubmit={() => { void blind.submit(); }} onRetry={() => { void blind.retry(); }} />
    <MemoriesPanel locale={locale} view={memoriesView} onDraft={memories.setDraft} onBody={memories.setBody}
      onLocalDate={memories.setLocalDate} onConsent={memories.setConsent} onCancel={memories.cancel}
      onCreate={() => { void memories.create(); }} onRetry={() => { void memories.retry(); }} onList={() => { void memories.list(); }} />
    <SongsPanel locale={locale} view={songsView} onDraft={songs.setDraft} onExplanation={songs.setExplanation} onMusicUrl={songs.setMusicUrl}
      onConsent={songs.setConsent} onCancel={songs.cancel}
      onCreate={() => { void songs.create(); }} onRetry={() => { void songs.retry(); }} onList={() => { void songs.list(); }} />
    <DatesPanel onEdit={dates.beginEdit} locale={locale} view={datesView} onDraft={dates.setDraft} onLocalDate={dates.setLocalDate}
      onRecurrence={dates.setRecurrence} onLeapDayPolicy={dates.setLeapDayPolicy} onTimezone={dates.setTimezone} onCancel={dates.cancel} onCreate={() => { void dates.create(); }}
      onRetry={() => { void dates.retry(); }} onList={() => { void dates.list(); }} />
    <TasksPanel locale={locale} view={tasksView} onDraft={tasks.setDraft} onCancel={tasks.cancel}
      onCreate={() => { void tasks.create(); }} onRetry={() => { void tasks.retry(); }}
      onList={() => { void tasks.list(); }} onComplete={id => { void tasks.complete(id); }}
      onReopen={id => { void tasks.reopen(id); }} />
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
