import { SongLink } from './SongLink';
import { Pressable, Text, TextInput, View } from 'react-native';
import { songsCopy } from './songsCopy';
import type { SongsView } from './songs';
export function SongsPanel({ locale, view, onDraft, onExplanation, onMusicUrl, onCreate, onRetry, onList, onConsent, onCancel, onEdit }: {
  locale: 'ru' | 'en'; view: SongsView; onDraft(text: string): void; onExplanation(text: string): void; onMusicUrl(text: string): void;
  onCreate(): void; onRetry(): void; onList(): void; onConsent(value: boolean): void; onCancel(): void; onEdit(id: string): void;
}) {
  if (!view.available) return null;
  const t = songsCopy[locale];
  const button = (label: string, action: () => void, disabled: boolean) => <Pressable accessibilityRole="button"
    accessibilityState={{ disabled, busy: view.busy }} disabled={disabled} onPress={action}
    style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  return <View style={{ padding: 16, gap: 8 }}>
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text><Text>{t.limits}</Text><Text>{t.editRule}</Text>
    {view.editing && <Text>{t.editNotice} {view.editing.id} · v{view.editing.version}</Text>}
    <TextInput accessibilityLabel={t.draft} value={view.draft} onChangeText={onDraft}
      maxLength={800} style={{ minHeight: 48, borderWidth: 1, padding: 8 }} />
    <TextInput accessibilityLabel={t.explanation} value={view.explanation} onChangeText={onExplanation} multiline
      maxLength={8000} style={{ minHeight: 96, borderWidth: 1, padding: 8 }} />
    <TextInput accessibilityLabel={t.musicUrl} value={view.musicUrl} onChangeText={onMusicUrl}
      autoCapitalize="none" autoCorrect={false} maxLength={513} keyboardType="url"
      style={{ minHeight: 48, borderWidth: 1, padding: 8 }} /><Text>{t.linkHelp}</Text>
    <Pressable accessibilityRole="checkbox" accessibilityLabel={t.consent} accessibilityState={{ checked: view.consent }}
      onPress={() => onConsent(!view.consent)} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{view.consent ? '☑ ' : '☐ '}{t.consent}</Text></Pressable>
    {button(view.editing ? t.saveEdit : t.create, onCreate, view.busy || view.requiresRefresh || view.pending !== null || !view.consent)}
    {button(t.cancel, onCancel, false)}<Text>{t.cancelHint}</Text>
    {view.pending && <Text selectable>{t.pending} {view.pending.editing ? t.editNotice + ' ' + view.pending.editing.id + ' · v' + view.pending.editing.version + '\n' : ''}{view.pending.title}{'\n'}{view.pending.explanation}{view.pending.musicUrl ? '\n' + view.pending.musicUrl : ''}</Text>}
    {view.status === 'retry' && button(t.again, onRetry, view.busy)}
    <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>
    {button(t.list, onList, view.busy)}{view.error && <Text>{t.error}</Text>}
    <Text>{t.bound}</Text>{view.checked && view.songs.length === 0 && <Text>{t.none}</Text>}
    {view.songs.map(song => <View key={song.id} style={{ paddingVertical: 8 }}>
      <Text selectable>{song.title}</Text><Text selectable>{song.explanation}</Text>
      {song.musicUrl && <SongLink key={song.musicUrl} url={song.musicUrl} locale={locale} />}
      <Text>{t.recorded} {song.createdAt}</Text>
      <Text>{t.author} {song.creatorId}</Text>
      {song.creatorId === view.userId && button(t.edit, () => onEdit(song.id), view.busy || view.requiresRefresh
        || view.pending !== null || view.editing !== null || Boolean(view.draft || view.explanation || view.musicUrl) || song.version >= 2147483647)}
    </View>)}
  </View>;
}
