import { useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { AsksActions } from './asks';
import type { AskQuestion } from './asks-state';
const copy = {
    ru: {
        title: 'Вопросы друг другу', notice: 'Вопросы и ответы видны обоим. Ответить или пропустить вопрос можно по желанию, без срока и объяснения причины.',
        load: 'Обновить все вопросы', checked: 'Полный список проверен.', unchecked: 'Полный список сейчас не подтверждён. Обновите его вручную.', asOf: 'Последнее полное обновление:',
        cap: 'Технический предел тестовой версии: 100 вопросов за всё время, включая удалённые и завершённые. Это не тариф. Удаление не освобождает место.', remaining: 'Осталось мест по известным данным:', empty: 'В проверенном списке пока нет вопросов.',
        questionBy: 'Автор вопроса:', responseBy: 'Ответ от:', you: 'Вы', partner: 'Партнёр', removed: 'Текст вопроса удалён автором.',
        waiting: 'Ответа пока нет.', skipped: 'Вопрос пропущен. Ответ на него больше не добавляется.', withdrawn: 'Вопрос отозван до ответа.', answer_removed: 'Ответ удалён его автором. Новый ответ не добавляется.', answered: 'Ответ сохранён.', answeredAt: 'Метка времени ответа:', timestampHint: 'Не раньше даты вопроса; не отметка прочтения.',
        textLimit: 'Вопрос и ответ: от 1 до 2000 символов.',
        questionDraft: 'Новый вопрос', publish: 'Отправить вопрос партнёру', cancelCreate: 'Отменить новый вопрос',
        beginAnswer: 'Ответить', skip: 'Пропустить', removeQuestion: 'Удалить свой вопрос', removeAnswer: 'Удалить свой ответ',
        answerDraft: 'Ваш несохранённый ответ', sendAnswer: 'Сохранить ответ для обоих', cancelAnswer: 'Отменить ответ',
        changed: 'Вопрос изменился. Ваш несохранённый черновик остался здесь; отмените его или заново откройте актуальный вопрос перед ответом.',
        terminal: 'Этот вопрос больше не принимает ответ. Ваш несохранённый черновик остался здесь; можно отменить его, но отправить нельзя.',
        confirmSkip: 'Пропустить этот вопрос без объяснения? Это окончательно: ответ на него добавить уже нельзя.',
        confirmQuestion: 'Удалить текст своего вопроса для обоих? Уже сохранённый ответ партнёра останется. Если вопрос ещё ждёт ответа, он будет отозван. Пропуск или ранее удалённый ответ не изменятся.',
        confirmAnswer: 'Удалить свой ответ для обоих? Это окончательно: новый ответ на этот вопрос добавить уже нельзя. Вопрос партнёра останется, если он не был удалён раньше.',
        confirm: 'Подтвердить', cancel: 'Оставить без изменений', retryButton: 'Повторить ту же команду',
        pending: 'Команда отправлена, результат ещё не подтверждён. Новый текст в форме не меняет повторяемую команду.',
        ram: 'Черновики только в памяти. Отмена очищает форму, но не отменяет уже отправленную команду. Проверка ручная, без уведомлений и синхронизации в реальном времени.',
        idle: '', saving: 'Сохраняем…', retry: 'Результат неизвестен.', saved: 'Команда подтверждена. Остальные вопросы требуют ручного обновления.', invalid: 'Проверьте текст.', conflict: 'Вопрос изменился. Обновите список перед следующим действием.', unavailable: 'Вопросы недоступны.', limit: 'Достигнут технический предел вопросов.', error: 'Не удалось подтвердить состояние вопросов.',
    },
    en: {
        title: 'Questions for each other', notice: 'Questions and answers are visible to both. Answer or skip only if you want to, with no deadline or explanation required.',
        load: 'Refresh all questions', checked: 'Full list checked.', unchecked: 'The full list is not currently confirmed. Refresh it manually.', asOf: 'Last full refresh:',
        cap: 'Technical test limit: 100 lifetime questions, including removed and completed questions. This is not a pricing tier. Deletion does not free capacity.', remaining: 'Remaining capacity in known data:', empty: 'No questions in the checked list yet.',
        questionBy: 'Question by:', responseBy: 'Response by:', you: 'You', partner: 'Partner', removed: 'Question text removed by its author.',
        waiting: 'No response yet.', skipped: 'Question skipped. An answer can no longer be added.', withdrawn: 'Question withdrawn before an answer.', answer_removed: 'Answer removed by its author. A new answer cannot be added.', answered: 'Answer saved.', answeredAt: 'Answer timestamp:', timestampHint: 'Not before the question date; not a read receipt.',
        textLimit: 'Questions and answers: 1–2000 characters.',
        questionDraft: 'New question', publish: 'Send question to partner', cancelCreate: 'Cancel new question',
        beginAnswer: 'Answer', skip: 'Skip', removeQuestion: 'Remove your question', removeAnswer: 'Remove your answer',
        answerDraft: 'Your unsaved answer', sendAnswer: 'Save answer for both', cancelAnswer: 'Cancel answer',
        changed: 'This question changed. Your unsaved draft remains here; cancel it or reopen the current question before answering.',
        terminal: 'This question no longer accepts an answer. Your unsaved draft remains here; you can cancel it but cannot send it.',
        confirmSkip: 'Skip this question without an explanation? This is final: an answer cannot be added later.',
        confirmQuestion: 'Remove your question text for both? An already saved partner answer will remain. If the question is still waiting for a response, it will be withdrawn. A skipped or previously removed answer state will not change.',
        confirmAnswer: 'Remove your answer for both? This is final: a new answer cannot be added to this question. The partner’s question will remain unless it was already removed.',
        confirm: 'Confirm', cancel: 'Keep unchanged', retryButton: 'Retry same command',
        pending: 'A command was sent; its outcome is not confirmed yet. New form text does not change the command being retried.',
        ram: 'Drafts are memory-only. Cancel clears a form but does not undo a submitted command. Manual refresh, without notifications or real-time sync.',
        idle: '', saving: 'Saving…', retry: 'Outcome unknown.', saved: 'Command confirmed. Other questions still need manual refresh.', invalid: 'Check the text.', conflict: 'Question changed. Refresh the list before the next action.', unavailable: 'Questions unavailable.', limit: 'Technical question limit reached.', error: 'Could not confirm question state.',
    },
};
type ConfirmationKind = 'skip' | 'question' | 'answer';
function permitted(question: AskQuestion, kind: ConfirmationKind, actor: string | null) {
    if (kind === 'question')
        return question.authorId === actor && question.questionState === 'active';
    if (kind === 'answer')
        return question.recipientId === actor && question.responseState === 'answered';
    return question.recipientId === actor && question.questionState === 'active' && question.responseState === 'waiting';
}
export function AsksPanel({ controller, locale }: {
    controller: AsksActions;
    locale: 'ru' | 'en';
}) {
    const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    // Confirmation retains identity only, never removed question or answer text.
    const [confirmation, setConfirmation] = useState<{
        id: string;
        version: number;
        kind: ConfirmationKind;
        actor: string | null;
    } | null>(null);
    if (!view.available)
        return null;
    const t = copy[locale], blocked = view.busy || view.pending || view.requiresRefresh;
    const confirming = confirmation && confirmation.actor === view.userId && view.questions.find(question => question.id === confirmation.id && question.version === confirmation.version && permitted(question, confirmation.kind, view.userId));
    const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
    const begin = (question: AskQuestion, kind: ConfirmationKind) => setConfirmation({ id: question.id, version: question.version, kind, actor: view.userId });
    const confirm = () => {
        if (!confirming || !confirmation)
            return;
        if (confirmation.kind === 'skip')
            void controller.skip(confirming.id, true);
        else if (confirmation.kind === 'question')
            void controller.removeQuestion(confirming.id, true);
        else
            void controller.removeAnswer(confirming.id, true);
        setConfirmation(null);
    };
    return <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
    {button(t.load, () => { void controller.load(); }, view.busy)}
    <Text>{view.checked ? t.checked : t.unchecked}</Text>{view.checkedAt && <Text>{t.asOf} {view.checkedAt}</Text>}
    <Text>{t.cap}</Text><Text>{t.remaining} {Math.max(0, view.capacity - view.used)}</Text>
    {view.checked && view.questions.length === 0 && <Text>{t.empty}</Text>}
    {view.questions.map((question, index) => <View key={question.id} style={{ paddingVertical: 8, gap: 4 }}>
      <Text>{t.questionBy} {question.authorId === view.userId ? t.you : t.partner}</Text>
      <Text selectable>{question.questionState === 'active' ? question.question : t.removed}</Text>
      <Text>{t.responseBy} {question.recipientId === view.userId ? t.you : t.partner}</Text>
      <Text>{t[question.responseState]}</Text>
      {question.responseState === 'answered' && <Text selectable>{question.answer}</Text>}
      {(question.responseState === 'answered' || question.responseState === 'answer_removed') && <View><Text>{t.answeredAt} {question.answeredAt}</Text><Text>{t.timestampHint}</Text></View>}
      {permitted(question, 'skip', view.userId) && <View>
        {button(`${t.beginAnswer} ${index + 1}`, () => controller.beginAnswer(question.id), blocked)}
        {button(`${t.skip} ${index + 1}`, () => begin(question, 'skip'), blocked)}
      </View>}
      {permitted(question, 'question', view.userId) && button(`${t.removeQuestion} ${index + 1}`, () => begin(question, 'question'), blocked)}
      {permitted(question, 'answer', view.userId) && button(`${t.removeAnswer} ${index + 1}`, () => begin(question, 'answer'), blocked)}
    </View>)}
    {confirming && confirmation && <View>
      <Text>{confirmation.kind === 'skip' ? t.confirmSkip : confirmation.kind === 'question' ? t.confirmQuestion : t.confirmAnswer}</Text>
      {confirming.questionState === 'active' && <Text selectable>{confirming.question}</Text>}
      {button(t.confirm, confirm, blocked)}{button(t.cancel, () => setConfirmation(null))}
    </View>}
    <Text>{t.textLimit}</Text>
    <TextInput maxLength={4000} accessibilityLabel={t.questionDraft} value={view.create} onChangeText={controller.setCreate} multiline style={{ minHeight: 72, borderWidth: 1, padding: 8 }}/>
    {button(t.publish, () => { void controller.create(); }, blocked || view.used >= view.capacity)}{button(t.cancelCreate, controller.cancelCreate)}
    {view.answerDraft && <View>
      <TextInput maxLength={4000} accessibilityLabel={t.answerDraft} value={view.answerDraft.text} onChangeText={controller.setAnswer} multiline style={{ minHeight: 72, borderWidth: 1, padding: 8 }}/>
      {view.answerDraft.stale && <Text accessibilityLiveRegion="polite">{view.answerDraft.stale === 'changed' ? t.changed : t.terminal}</Text>}
      {button(t.sendAnswer, () => { void controller.answer(); }, blocked || !!view.answerDraft.stale)}{button(t.cancelAnswer, controller.cancelAnswer)}
    </View>}
    {view.pending && <Text>{t.pending}</Text>}{view.status === 'retry' && button(t.retryButton, () => { void controller.retry(); }, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>{view.error && <Text>{t.error}</Text>}<Text>{t.ram}</Text>
  </ScrollView>;
}
