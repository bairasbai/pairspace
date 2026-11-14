import { NotificationPreferencesPanel } from './NotificationPreferencesPanel';
import { ArrivalPanel } from './ArrivalPanel';
import { PartingsPanel } from './PartingsPanel';
import { MorningDraftPanel } from './MorningDraftPanel';
import { MorningPreparedPanel } from './MorningPreparedPanel';
import { MorningDiscussionsPanel } from './MorningDiscussionsPanel';
import { MorningsPanel } from './MorningsPanel';
import { ChatReconciliationPanel } from './ChatReconciliationPanel';
import { ChatJournalPanel } from './ChatJournalPanel';
import { OutgoingAttemptPanel } from './OutgoingAttemptPanel';
import { ChatVisibilityPanel } from './ChatVisibilityPanel';
import { WishesPanel } from './WishesPanel';
import { SongsPanel } from './SongsPanel';
import { MemoriesPanel } from './MemoriesPanel';
import { DatesPanel } from './DatesPanel';
import { BlindPanel } from './BlindPanel';
import { TasksPanel } from './TasksPanel';
import { LeavePanel } from './LeavePanel';
import { LettersPanel } from './LettersPanel';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Button, ScrollView } from 'react-native';
import { CarePanel } from './CarePanel';
import { SyntheticChatPanel } from './SyntheticChatPanel';
import type { createSessionController } from './controller';
import type { Locale } from '../copy';
type CurrentSessionController = ReturnType<typeof createSessionController>;
/** Older injected preview controllers may omit this new capability. Real composition supplies it. */
export type SessionController = Omit<CurrentSessionController, 'stories' | 'hardQuestions' | 'sharedDoings'> & Partial<Pick<CurrentSessionController, 'stories' | 'hardQuestions' | 'sharedDoings'>>;
export function SyntheticChatConnected({ controller, locale, ownsController = true, showCareSend = true }: { controller: SessionController; locale: Locale; ownsController?: boolean; showCareSend?: boolean }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const reconciliation = controller.reconciliation;
  const reconciliationView = useSyncExternalStore(reconciliation.subscribe, reconciliation.getSnapshot);
  useEffect(() => {
    void reconciliation.appStateChanged(AppState.currentState ?? 'unknown');
    const listener = AppState.addEventListener('change', state => { void reconciliation.appStateChanged(state); });
    return () => listener.remove();
  }, [reconciliation]);
  const mornings = controller.mornings;
  const morningsView = useSyncExternalStore(mornings.subscribe, mornings.getSnapshot);
  const morningDraft = controller.morningDraft;
  const draftView = useSyncExternalStore(morningDraft.subscribe, morningDraft.getSnapshot);
  const morningPrepared = controller.morningPrepared;
  const preparedView = useSyncExternalStore(morningPrepared.subscribe, morningPrepared.getSnapshot);
  const morningDiscussions = controller.morningDiscussions;
  const discussionView = useSyncExternalStore(morningDiscussions.subscribe, morningDiscussions.getSnapshot);
  const journal = controller.journal;
  const journalView = useSyncExternalStore(journal.subscribe, journal.getSnapshot);
  const visibility = controller.visibility;
  const visibilityView = useSyncExternalStore(visibility.subscribe, visibility.getSnapshot);
  const blind = controller.blind;
  const blindView = useSyncExternalStore(blind.subscribe, blind.getSnapshot);
  const leave = controller.leave;
  const leaveView = useSyncExternalStore(leave.subscribe, leave.getSnapshot);
  const songs = controller.songs;
  const songsView = useSyncExternalStore(songs.subscribe, songs.getSnapshot);
  const memories = controller.memories;
  const memoriesView = useSyncExternalStore(memories.subscribe, memories.getSnapshot);
  const notificationPreferences = controller.notificationPreferences;
  const notificationPreferencesView = useSyncExternalStore(notificationPreferences.subscribe, notificationPreferences.getSnapshot);
  const arrival = controller.arrival;
  const arrivalView = useSyncExternalStore(arrival.subscribe, arrival.getSnapshot);
  const partings = controller.partings;
  const partingsView = useSyncExternalStore(partings.subscribe, partings.getSnapshot);
  const dates = controller.dates;
  const datesView = useSyncExternalStore(dates.subscribe, dates.getSnapshot);
  const wishes = controller.wishes;
  const wishesView = useSyncExternalStore(wishes.subscribe, wishes.getSnapshot);
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
    <SongsPanel onEdit={songs.beginEdit} locale={locale} view={songsView} onDraft={songs.setDraft} onExplanation={songs.setExplanation} onMusicUrl={songs.setMusicUrl}
      onConsent={songs.setConsent} onCancel={songs.cancel}
      onCreate={() => { void songs.create(); }} onRetry={() => { void songs.retry(); }} onList={() => { void songs.list(); }} />
    <NotificationPreferencesPanel locale={locale} view={notificationPreferencesView} onCategory={notificationPreferences.setCategory} onQuiet={notificationPreferences.setQuiet}
      onLoad={() => { void notificationPreferences.load(); }} onSave={() => { void notificationPreferences.save(); }} onRetry={() => { void notificationPreferences.retry(); }}
      onEdit={notificationPreferences.beginEdit} onCancel={notificationPreferences.cancel} onPreview={category => { void notificationPreferences.preview(category); }} />
    <ArrivalPanel locale={locale} view={arrivalView} onField={arrival.setField} onSave={() => { void arrival.save(); }}
      onLoad={() => { void arrival.load(); }} onRetry={() => { void arrival.retry(); }} onEdit={arrival.beginEdit} onCancel={arrival.cancel} />
    <PartingsPanel locale={locale} view={partingsView} onDraft={partings.setDraft} onStartDate={partings.setStartDate} onEndDate={partings.setEndDate}
      onTimezone={partings.setTimezone} onEdit={partings.beginEdit} onCancel={partings.cancel} onCreate={() => { void partings.create(); }}
      onRetry={() => { void partings.retry(); }} onList={() => { void partings.list(); }} />
    <DatesPanel onEdit={dates.beginEdit} locale={locale} view={datesView} onDraft={dates.setDraft} onLocalDate={dates.setLocalDate}
      onRecurrence={dates.setRecurrence} onLeapDayPolicy={dates.setLeapDayPolicy} onTimezone={dates.setTimezone} onCancel={dates.cancel} onCreate={() => { void dates.create(); }}
      onRetry={() => { void dates.retry(); }} onList={() => { void dates.list(); }} />
    <TasksPanel locale={locale} view={tasksView} onDraft={tasks.setDraft} onCancel={tasks.cancel}
      onCreate={() => { void tasks.create(); }} onRetry={() => { void tasks.retry(); }}
      onList={() => { void tasks.list(); }} onComplete={id => { void tasks.complete(id); }}
      onReopen={id => { void tasks.reopen(id); }} />
    <WishesPanel locale={locale} view={wishesView} onDraft={wishes.setDraft} onCancel={wishes.cancel} onExplanation={wishes.setExplanation} onConsent={wishes.setConsent}
      onCreate={() => { void wishes.create(); }} onRetry={() => { void wishes.retry(); }}
      onList={() => { void wishes.list(); }} onFulfill={id => { void wishes.fulfill(id); }}
      onReopen={id => { void wishes.reopen(id); }} />
    <MorningsPanel locale={locale} view={morningsView} actions={mornings} />
    <MorningDraftPanel locale={locale} selected={morningsView.selected} view={draftView} actions={morningDraft} />
    <MorningPreparedPanel locale={locale} selected={morningsView.selected} view={preparedView} actions={morningPrepared} />
    <MorningDiscussionsPanel locale={locale} view={discussionView} actions={morningDiscussions}
      openedSlot={morningsView.opened?.slot ?? null} onOpenSaved={slot => {
        void mornings.openDiscussionSlot(slot).then(opened => {
          if (opened) void morningDiscussions.open(opened);
        });
      }} />
    <LettersPanel locale={locale} view={lettersView} onDraft={letters.setDraft}
      onReleaseAt={letters.setReleaseAt} onReleaseTimezone={letters.setReleaseTimezone}
      onSendLater={() => { void letters.sendLater(); }} onSend={() => { void letters.send(); }} onList={() => { void letters.list(); }}
      onOpen={id => { void letters.open(id); }} onClose={letters.close} />
    <CarePanel showSend={showCareSend} locale={locale} view={careView} onSend={() => { void care.send(); }} onRead={() => { void care.read(); }} />
    {view.phase === 'signed_in' && <ChatVisibilityPanel locale={locale} view={visibilityView}
      onConfirm={token=>{void visibility.confirm(token);}} onCancel={visibility.cancel} onRetry={()=>{void visibility.retry();}}
      onRestore={visibility.beginRestore} onLatest={()=>{void visibility.loadLatest();}} onOldest={()=>{void visibility.loadOldest();}}
      onOlder={()=>{void visibility.loadOlder();}} onNewer={()=>{void visibility.loadNewer();}}/>}
    {view.phase === 'blocked' && view.error === 'auth_required' && journalView.enabled && <Button title={locale === 'ru' ? 'Войти снова для восстановления журнала' : 'Sign in again to recover journal'} onPress={controller.resumeJournalSignIn} />}
    {view.phase === 'signed_in' && <ChatJournalPanel locale={locale} view={journalView}
      onCheck={() => { void journal.check(); }} onRestore={() => { void journal.restore(); }} onFlush={() => { void journal.flush(); }}
      onConflict={(token, choice) => { void journal.resolveConflict(token, choice); }} onVerify={() => { void journal.verifyReply(); }}
      onBeginReset={journal.beginReset} onCancelReset={journal.cancelReset} onConfirmReset={token => { void journal.confirmReset(token); }}
      onRemove={journal.removeReply} onRetry={() => { void controller.send(); }} />}
    {view.phase === 'signed_in' && <OutgoingAttemptPanel locale={locale} pending={view.outgoingPending}
      confirmation={view.discardConfirmation} onBegin={controller.beginDiscardOutgoing}
      onCancel={controller.cancelDiscardOutgoing} onConfirm={controller.confirmDiscardOutgoing} />}
    {view.phase === 'signed_in' && <ChatReconciliationPanel locale={locale} view={reconciliationView} attachmentUnavailable={!!view.replyAttachmentUnavailable} onRemoveAttachment={controller.cancelReply}
      onCheck={() => { void reconciliation.check(); }} onLatest={() => { void controller.loadLatest(); }} />}
    <SyntheticChatPanel {...view} onHide={id=>{void visibility.beginHide(id);}} locale={locale}
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
    onBeginEdit={controller.beginEdit} onEditDraft={controller.setEditDraft} onCancelEdit={controller.cancelEdit}
    onSaveEdit={()=>{void controller.saveEdit();}} onRetryEdit={()=>{void controller.retryEdit();}} onReloadEdit={()=>{void controller.reloadEdit();}}
    onBeginDelete={controller.beginDelete} onCancelDelete={controller.cancelDelete}
    onConfirmDelete={token => { void controller.confirmDelete(token); }} onRetryDelete={() => { void controller.retryDelete(); }}
    onReplyTarget={controller.setReplyTarget} onCancelReply={controller.cancelReply}
    onOpenReplyTarget={id => { void controller.openReplyTarget(id); }} onCloseReplyDetail={controller.closeReplyDetail}
    onLoadNewer={() => { void controller.loadNewer(); }}
    onLoadLatest={() => { void controller.loadLatest(); }}
    onLoadOldest={() => { void controller.loadOldest(); }}
    onLoadOlder={() => { void controller.loadOlder(); }}
    onRefresh={() => { void controller.refresh(); }} />
  </ScrollView>;
}
