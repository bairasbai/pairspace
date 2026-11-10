import { blindQuestions, findBlindQuestion } from '../../../../packages/domain/blind/catalog';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import { blindCopy } from './blindCopy';
import type { BlindView } from './blind-state';
export function BlindPanel({ locale, view, onDraft, onConsent, onOpen, onRead, onSubmit, onRetry, onList, onSelect, onNext }: {
  locale: 'ru' | 'en'; view: BlindView; onDraft(value: string): void; onConsent(value: boolean): void;
  onList?(): void; onSelect?(id: string): void; onNext?(id: string, version: number, confirm: boolean): void;
  onOpen(): void; onRead(): void; onSubmit(): void; onRetry(): void;
}) {
  if (!view.available) return null;
  const t = blindCopy[locale], blocked = view.busy || view.pending !== null || view.requiresRefresh || ((view.currentRoundId !== null || view.rounds.length > 0) && view.selectedRoundId !== view.currentRoundId);
  const button = (label: string, action: () => void, disabled: boolean) => <Pressable accessibilityRole="button"
    accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action}
    style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  return <View style={{ padding: 16, gap: 8 }}>
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
    {!view.round && button(t.open, onOpen, blocked)}
    {button(t.read, onRead, view.busy)}
    {onList && button(t.history, onList, view.busy)}
    <Text>{t.window}</Text>
    {view.currentRoundId === null && view.rounds.length > 0 && <Text>{t.verifyCurrent}</Text>}
    {view.rounds.map(item => <View key={item.id}>
      {button((item.id === view.currentRoundId ? t.current + ': ' : '') + item.id + ' · ' + findBlindQuestion(item.questionId, item.catalogVersion)![locale],
        () => onSelect?.(item.id), false)}
    </View>)}
    {view.round && <View style={{ gap: 8 }}>
      <Text>{findBlindQuestion(view.round.questionId, view.round.catalogVersion)![locale]}</Text>
      {view.round.ownAnswer === null ? <>
        <TextInput accessibilityLabel={t.draft} value={view.draft} onChangeText={onDraft}
          editable={!blocked} multiline maxLength={4000}
          style={{ minHeight: 96, borderWidth: 1, padding: 8 }} />
        <Text>{t.consent}</Text><Switch accessibilityLabel={t.consent} value={view.consent}
          disabled={blocked} onValueChange={onConsent} />
        {button(t.submit, onSubmit, blocked || !view.consent)}
      </> : <><Text>{t.own}</Text><Text selectable>{view.round.ownAnswer}</Text></>}
      {view.round.revealed ? <><Text>{t.partner}</Text><Text selectable>{view.round.partnerAnswer}</Text></>
        : <Text>{t.hidden}</Text>}
    </View>}
    {view.round?.revealed && view.round.id === view.currentRoundId && onNext && <View>
      {blindQuestions.map(question => <View key={question.id}>
        {button(t.next + ' ' + question[locale], () => onNext(question.id, question.catalogVersion, true), blocked)}
      </View>)}
    </View>}
    {view.status === 'retry'  && button(t.again, onRetry, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>
    {view.error && <Text>{t.error}</Text>}
  </View>;
}
