import { useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { StemsActions } from './stems';
import type { StemRound } from './stems-state';
const copy = {
    ru: {
        title: 'Продолжи фразу', notice: 'Автор делится началом фразы и сохраняет своё продолжение. Партнёр может добавить своё продолжение: тогда оба текста станут видны обоим. Участие добровольное, без срока и оценки совпадений.',
        load: 'Обновить все фразы', checked: 'Полный список проверен.', unchecked: 'Полный список сейчас не подтверждён. Обновите его вручную.', asOf: 'Последнее полное обновление:',
        cap: 'Технический предел тестовой версии: 100 фраз за всё время, включая удалённые и завершённые. Это не тариф. Удаление не освобождает место; продолжать, пропускать и удалять свои тексты можно и при заполненном лимите.', remaining: 'Осталось мест по известным данным:', empty: 'В проверенном списке пока нет фраз.',
        author: 'Автор начала:', recipient: 'Продолжает:', you: 'Вы', partner: 'Партнёр', authorText: 'Продолжение автора:', recipientText: 'Продолжение партнёра:', yourText: 'Ваше продолжение:',
        skippedHidden: 'Фраза пропущена: продолжение автора останется скрытым от вас и больше не раскроется.',
        hidden: 'Продолжение автора скрыто от вас до вашего ответа. Пропуск его не раскроет.', bundleRemoved: 'Начало и продолжение автора удалены.', absent: 'Продолжение получателя не опубликовано.', recipientRemoved: 'Продолжение получателя удалено; новый ответ не добавляется.',
        waiting: 'Можно продолжить или пропустить по желанию.', completed: 'Продолжения были раскрыты. Удаление своего текста не скрывает оставшийся текст партнёра.', skipped: 'Фраза пропущена. Новое продолжение не добавляется.', withdrawn: 'Автор отозвал фразу до продолжения.',
        completedAt: 'Метка завершения:', timeHint: 'Не раньше даты фразы; не отметка прочтения.',
        beginning: 'Начало фразы (1–500 символов)', ownContinuation: 'Ваше продолжение (1–2000 символов)', continuation: 'Ваш несохранённый ответ (1–2000 символов)',
        create: 'Предложить фразу', cancelCreate: 'Отменить новую фразу', begin: 'Продолжить', complete: 'Опубликовать продолжение', cancelComplete: 'Отменить ответ', skip: 'Пропустить', removeAuthor: 'Удалить свои начало и продолжение', removeRecipient: 'Удалить своё продолжение',
        confirmCreate: 'Начало станет видно партнёру сейчас. Ваше продолжение будет скрыто от партнёра, пока он не отправит своё; затем оба продолжения станут общими. Изменить отправленные тексты нельзя, но свой набор текстов можно удалить.',
        confirmComplete: 'Отправить своё продолжение и раскрыть оба текста для обоих? Это добровольная однократная публикация. Изменить текст или ответить заново нельзя.',
        confirmSkip: 'Пропустить без объяснения? Это окончательно. Продолжение автора не раскроется, свой ответ добавить уже нельзя.',
        confirmAuthor: 'Удалить свои начало и продолжение? Ожидающая фраза будет отозвана. При завершённой фразе продолжение партнёра останется видимым; пропущенная останется пропущенной. Уже прочитанные копии не исчезнут.',
        confirmRecipient: 'Удалить только своё продолжение? Оставшиеся тексты автора останутся видимыми. Фраза не закроется заново; заменить ответ нельзя. Уже прочитанные копии не исчезнут.',
        confirm: 'Подтвердить', cancelConfirm: 'Не подтверждать',
        changed: 'Фраза изменилась. Несохранённый ответ остался здесь; отмените его или заново откройте актуальную фразу перед отправкой.',
        terminal: 'Эта фраза больше не принимает продолжение. Несохранённый ответ остался здесь, но отправить его нельзя.',
        pending: 'Команда уже отправлена; результат ещё не подтверждён. Новый ввод не меняет повторяемую команду.', retryButton: 'Повторить ту же команду',
        ram: 'Черновики только в памяти. Отмена очищает форму, но не отменяет отправленную команду. Проверка ручная, без уведомлений и синхронизации в реальном времени.',
        idle: '', saving: 'Сохраняем…', retry: 'Результат неизвестен.', saved: 'Команда подтверждена. Остальные фразы требуют ручного обновления.', invalid: 'Проверьте тексты и подтверждение.', conflict: 'Фраза изменилась. Обновите список.', unavailable: 'Фразы недоступны.', limit: 'Достигнут технический предел фраз.', error: 'Не удалось подтвердить состояние фраз.',
    },
    en: {
        title: 'Continue the phrase', notice: 'An author shares a beginning and commits their continuation. Their partner can add a continuation, revealing both texts to both people. Participation is optional, without a deadline or similarity score.',
        load: 'Refresh all phrases', checked: 'Full list checked.', unchecked: 'The full list is not currently confirmed. Refresh it manually.', asOf: 'Last full refresh:',
        cap: 'Technical test limit: 100 lifetime phrases, including removed and completed phrases. This is not a pricing tier. Deletion does not free capacity; continuing, skipping and removing your texts remain possible at the limit.', remaining: 'Remaining capacity in known data:', empty: 'No phrases in the checked list yet.',
        author: 'Beginning by:', recipient: 'Continuation by:', you: 'You', partner: 'Partner', authorText: 'Author’s continuation:', recipientText: 'Partner’s continuation:', yourText: 'Your continuation:',
        skippedHidden: 'This phrase was skipped: the author’s continuation will remain hidden from you permanently.',
        hidden: 'The author’s continuation is hidden from you until you submit yours. Skipping will not reveal it.', bundleRemoved: 'Author’s beginning and continuation removed.', absent: 'Recipient continuation not published.', recipientRemoved: 'Recipient continuation removed; a new response cannot be added.',
        waiting: 'Continue or skip only if you want to.', completed: 'Continuations were revealed. Removing your text does not hide the remaining partner text.', skipped: 'Phrase skipped. A new continuation cannot be added.', withdrawn: 'Author withdrew the phrase before completion.',
        completedAt: 'Completion timestamp:', timeHint: 'Not before the phrase date; not a read receipt.',
        beginning: 'Phrase beginning (1–500 characters)', ownContinuation: 'Your continuation (1–2000 characters)', continuation: 'Your unsaved response (1–2000 characters)',
        create: 'Offer a phrase', cancelCreate: 'Cancel new phrase', begin: 'Continue', complete: 'Publish continuation', cancelComplete: 'Cancel response', skip: 'Skip', removeAuthor: 'Remove your beginning and continuation', removeRecipient: 'Remove your continuation',
        confirmCreate: 'The beginning becomes visible to your partner now. Your continuation stays hidden from them until they submit theirs; then both continuations are shared. Submitted texts cannot be edited, but you can remove your own text bundle.',
        confirmComplete: 'Publish your continuation and reveal both texts to both people? This is an optional, one-time publication. The text cannot be edited or replaced with another response.',
        confirmSkip: 'Skip without an explanation? This is final. The author’s continuation will not be revealed, and you cannot add your own later.',
        confirmAuthor: 'Remove your beginning and continuation? A waiting phrase will be withdrawn. For a completed phrase, the partner’s continuation remains visible; a skipped phrase stays skipped. Already-read copies will not disappear.',
        confirmRecipient: 'Remove only your continuation? The author’s remaining texts stay visible. The phrase does not relock; no replacement response is allowed. Already-read copies will not disappear.',
        confirm: 'Confirm', cancelConfirm: 'Do not confirm',
        changed: 'This phrase changed. Your unsaved response remains here; cancel it or reopen the current phrase before submitting.',
        terminal: 'This phrase no longer accepts a continuation. Your unsaved response remains here but cannot be submitted.',
        pending: 'A command was sent; its outcome is not confirmed yet. New input does not change the command being retried.', retryButton: 'Retry same command',
        ram: 'Drafts are memory-only. Cancel clears a form but does not undo a submitted command. Manual refresh, without notifications or real-time sync.',
        idle: '', saving: 'Saving…', retry: 'Outcome unknown.', saved: 'Command confirmed. Other phrases still need manual refresh.', invalid: 'Check the texts and confirmation.', conflict: 'Phrase changed. Refresh the list.', unavailable: 'Phrases unavailable.', limit: 'Technical phrase limit reached.', error: 'Could not confirm phrase state.',
    },
};
type Kind = 'create' | 'complete' | 'skip' | 'author' | 'recipient';
type Confirmation = {
    kind: Kind;
    actor: string | null;
    id?: string;
    version?: number;
};
function permitted(round: StemRound, kind: Kind, actor: string | null) {
    if (kind === 'author')
        return round.authorId === actor && round.authorTextState === 'active';
    if (kind === 'recipient')
        return round.recipientId === actor && round.phase === 'completed' && round.recipientTextState === 'active';
    return round.recipientId === actor && round.phase === 'waiting';
}
export function StemsPanel({ controller, locale }: {
    controller: StemsActions;
    locale: 'ru' | 'en';
}) {
    const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    if (!view.available)
        return null;
    const t = copy[locale], blocked = view.busy || view.pending || view.requiresRefresh;
    const target = confirmation && view.rounds.find(round => round.id === confirmation.id && round.version === confirmation.version && permitted(round, confirmation.kind, view.userId));
    const confirming = confirmation && confirmation.actor === view.userId && (confirmation.kind === 'create' || target &&
        (confirmation.kind !== 'complete' || view.completionDraft?.id === target.id && view.completionDraft.version === target.version && !view.completionDraft.stale));
    const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
    const begin = (round: StemRound, kind: Kind) => setConfirmation({ kind, actor: view.userId, id: round.id, version: round.version });
    const submit = () => {
        if (!confirmation)
            return;
        switch (confirmation.kind) {
            case 'create':
                void controller.create(true);
                break;
            case 'complete':
                void controller.complete(true);
                break;
            case 'skip':
                void controller.skip(confirmation.id!, true);
                break;
            case 'author':
                void controller.removeAuthorBundle(confirmation.id!, true);
                break;
            case 'recipient':
                void controller.removeRecipientContinuation(confirmation.id!, true);
                break;
        }
        setConfirmation(null);
    };
    const confirmText = confirmation?.kind === 'create' ? t.confirmCreate : confirmation?.kind === 'complete' ? t.confirmComplete : confirmation?.kind === 'skip' ? t.confirmSkip : confirmation?.kind === 'author' ? t.confirmAuthor : t.confirmRecipient;
    return <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
    {button(t.load, () => { void controller.load(); }, view.busy)}
    <Text>{view.checked ? t.checked : t.unchecked}</Text>{view.checkedAt && <Text>{t.asOf} {view.checkedAt}</Text>}
    <Text>{t.cap}</Text><Text>{t.remaining} {Math.max(0, view.capacity - view.used)}</Text>
    {view.checked && view.rounds.length === 0 && <Text>{t.empty}</Text>}
    {view.rounds.map((round, index) => <View key={round.id} style={{ paddingVertical: 8, gap: 4 }}>
      <Text>{t.author} {round.authorId === view.userId ? t.you : t.partner}</Text>
      <Text>{t.recipient} {round.recipientId === view.userId ? t.you : t.partner}</Text>
      {round.authorTextState === 'active' ? <View><Text selectable>{round.beginning}</Text>
        {round.authorId === view.userId || round.phase === 'completed' ? <View><Text>{round.authorId === view.userId ? t.yourText : t.authorText}</Text><Text selectable>{round.authorContinuation}</Text></View> : <Text>{round.phase === 'skipped' ? t.skippedHidden : t.hidden}</Text>}
      </View> : <Text>{t.bundleRemoved}</Text>}
      {round.recipientTextState === 'active' ? <View><Text>{round.recipientId === view.userId ? t.yourText : t.recipientText}</Text><Text selectable>{round.recipientContinuation}</Text></View> : <Text>{round.recipientTextState === 'removed' ? t.recipientRemoved : t.absent}</Text>}
      <Text>{t[round.phase]}</Text>{round.phase === 'completed' && <View><Text>{t.completedAt} {round.completedAt}</Text><Text>{t.timeHint}</Text></View>}
      {permitted(round, 'complete', view.userId) && <View>{button(`${t.begin} ${index + 1}`, () => controller.beginComplete(round.id), blocked)}{button(`${t.skip} ${index + 1}`, () => begin(round, 'skip'), blocked)}</View>}
      {permitted(round, 'author', view.userId) && button(`${t.removeAuthor} ${index + 1}`, () => begin(round, 'author'), blocked)}
      {permitted(round, 'recipient', view.userId) && button(`${t.removeRecipient} ${index + 1}`, () => begin(round, 'recipient'), blocked)}
    </View>)}
    <TextInput accessibilityLabel={t.beginning} value={view.create.beginning} onChangeText={text => controller.setCreate('beginning', text)} multiline maxLength={1000} style={{ minHeight: 72, borderWidth: 1, padding: 8 }}/>
    <TextInput accessibilityLabel={t.ownContinuation} value={view.create.ownContinuation} onChangeText={text => controller.setCreate('ownContinuation', text)} multiline maxLength={4000} style={{ minHeight: 72, borderWidth: 1, padding: 8 }}/>
    {button(t.create, () => setConfirmation({ kind: 'create', actor: view.userId }), blocked || view.used >= view.capacity)}{button(t.cancelCreate, () => { controller.cancelCreate(); setConfirmation(null); })}
    {view.completionDraft && <View>
      <TextInput accessibilityLabel={t.continuation} value={view.completionDraft.text} onChangeText={controller.setContinuation} multiline maxLength={4000} style={{ minHeight: 72, borderWidth: 1, padding: 8 }}/>
      {view.completionDraft.stale && <Text accessibilityLiveRegion="polite">{view.completionDraft.stale === 'changed' ? t.changed : t.terminal}</Text>}
      {button(t.complete, () => setConfirmation({ kind: 'complete', actor: view.userId, id: view.completionDraft!.id, version: view.completionDraft!.version }), blocked || !!view.completionDraft.stale)}
      {button(t.cancelComplete, () => { controller.cancelComplete(); setConfirmation(null); })}
    </View>}
    {confirming && confirmation && <View><Text>{confirmText}</Text>
      {confirmation.kind === 'create' && <View><Text selectable>{view.create.beginning}</Text><Text selectable>{view.create.ownContinuation}</Text></View>}
      {target?.authorTextState === 'active' && <Text selectable>{target.beginning}</Text>}
      {confirmation.kind === 'complete' && <Text selectable>{view.completionDraft!.text}</Text>}
      {button(t.confirm, submit, blocked || confirmation.kind === 'create' && view.used >= view.capacity)}{button(t.cancelConfirm, () => setConfirmation(null))}
    </View>}
    {view.pending && <Text>{t.pending}</Text>}{view.status === 'retry' && button(t.retryButton, () => { void controller.retry(); }, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>{view.error && <Text>{t.error}</Text>}<Text>{t.ram}</Text>
  </ScrollView>;
}
