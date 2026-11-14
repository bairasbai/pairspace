import { useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { StoriesActions } from './stories';
import type { StoriesView, StoryMetadata } from './stories-state';
import { storiesCopy } from './storiesCopy';
import { StoryReader } from './StoryReader';
type Confirmation = 'decline' | 'topic' | 'story';
function permitted(story: StoryMetadata, kind: Confirmation, actor: string | null) {
  return kind === 'topic' ? story.topicAuthorId === actor && story.topicState === 'active'
    : story.storyAuthorId === actor && (kind === 'story' ? story.storyState === 'told' : story.topicState === 'active' && story.storyState === 'waiting');
}
export function StoriesPanel({ controller, locale }: { controller: StoriesActions; locale: 'ru' | 'en' }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  // Reset/rebind can be batched without an unavailable render. A new generation
  // unmounts the old confirmation even when actor, record and version are equal.
  return view.available ? <StoriesContent key={view.generation} view={view} controller={controller} locale={locale}/> : null;
}
function StoriesContent({ view, controller, locale }: { view: StoriesView; controller: StoriesActions; locale: 'ru' | 'en' }) {
  // A confirmation holds metadata identity only, never the topic/body text.
  const [confirmation, setConfirmation] = useState<{ id: string; version: number; actor: string | null; kind: Confirmation } | null>(null);
  const t = storiesCopy[locale], blocked = view.busy || view.pending || view.requiresRefresh;
  const canRead = !view.pending && !view.requiresRefresh && (!view.busy || view.readerStatus === 'loading');
  const draftLength = view.storyDraft ? [...view.storyDraft.text.normalize('NFC').replace(/\r\n?/g, '\n').trim()].length : 0;
  const confirming = confirmation && confirmation.actor === view.userId && view.stories.find(s => s.id === confirmation.id && s.version === confirmation.version && permitted(s, confirmation.kind, view.userId));
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: view.busy }} disabled={disabled}
    onPress={action} style={{ minHeight: 48, justifyContent: 'center' }}><Text>{label}</Text></Pressable>;
  const begin = (story: StoryMetadata, kind: Confirmation) => setConfirmation({ id: story.id, version: story.version, actor: view.userId, kind });
  const confirm = () => {
    if (!confirmation || !confirming) return;
    if (confirmation.kind === 'decline') void controller.decline(confirming.id, true);
    else if (confirmation.kind === 'topic') void controller.removeTopic(confirming.id, true);
    else void controller.removeStory(confirming.id, true);
    setConfirmation(null);
  };
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text><Text>{t.visibility}</Text>
    {button(t.load, () => { void controller.load(); }, view.busy)}
    <Text>{view.checked ? t.checked : t.unchecked}</Text>{view.checkedAt && <Text>{t.asOf} {view.checkedAt}</Text>}
    <Text>{t.capacity}</Text><Text>{t.remaining} {Math.max(0, view.capacity - view.used)}</Text>
    {view.checked && view.stories.length === 0 && <Text>{t.empty}</Text>}
    {view.stories.map((story, index) => <View key={story.id} style={{ gap: 4, paddingVertical: 8 }}>
      <Text>{t.topicBy} {story.topicAuthorId === view.userId ? t.you : t.partner}</Text>
      <Text selectable>{story.topicState === 'active' ? story.topic : t.removedTopic}</Text>
      <Text>{t.storyBy} {story.storyAuthorId === view.userId ? t.you : t.partner}</Text>
      <Text>{t[story.storyState]}</Text>
      {story.toldAt && <Text>{t.toldAt} {story.toldAt} {t.timestamp}</Text>}
      {story.storyState === 'told' && button(`${t.open} ${index + 1}`, () => { void controller.open(story.id); }, !canRead)}
      {permitted(story, 'decline', view.userId) && <View>
        {button(`${t.begin} ${index + 1}`, () => controller.beginStory(story.id), blocked)}
        {button(`${t.decline} ${index + 1}`, () => begin(story, 'decline'), blocked)}
      </View>}
      {permitted(story, 'topic', view.userId) && button(`${t.removeTopic} ${index + 1}`, () => begin(story, 'topic'), blocked)}
      {permitted(story, 'story', view.userId) && button(`${t.removeStory} ${index + 1}`, () => begin(story, 'story'), blocked)}
    </View>)}
    {confirming && confirmation && <View>
      <Text>{confirmation.kind === 'decline' ? t.confirmDecline : confirmation.kind === 'topic' ? t.confirmTopic : t.confirmStory}</Text>
      {button(t.confirm, confirm, blocked)}{button(t.cancel, () => setConfirmation(null))}
    </View>}
    {view.readerStatus === 'loading' && <Text accessibilityLiveRegion="polite">{t.reading}</Text>}
    {view.opened && <StoryReader opened={view.opened} locale={locale} userId={view.userId}/>}
    {(view.opened || view.readerStatus === 'loading') && button(t.close, controller.close)}
    {view.readerStatus === 'changed' && <Text accessibilityLiveRegion="polite">{t.readerChanged}</Text>}
    {view.readerStatus === 'error' && <Text accessibilityLiveRegion="polite">{t.readerError}</Text>}
    <Text>{t.limits}</Text>
    <TextInput accessibilityLabel={t.topicLabel} maxLength={1200} multiline value={view.topicDraft} onChangeText={controller.setTopic} style={{ minHeight: 72, borderWidth: 1, padding: 8 }}/>
    {button(t.order, () => { void controller.order(); }, blocked || !view.checked || view.used >= 100)}{button(t.cancelTopic, controller.cancelTopic)}
    {view.storyDraft && <View>
      <TextInput accessibilityLabel={t.storyLabel} maxLength={32000} multiline value={view.storyDraft.text} onChangeText={controller.setStory} style={{ minHeight: 200, borderWidth: 1, padding: 8, textAlignVertical: 'top' }}/>
      <Text>{t.characters} {draftLength}/8000</Text>
      {view.storyDraft.stale && <Text accessibilityLiveRegion="polite">{t.stale}</Text>}
      {button(t.tell, () => { void controller.tell(); }, blocked || !!view.storyDraft.stale)}{button(t.cancelStory, controller.cancelStory)}
    </View>}
    {view.pending && <Text>{t.pending}</Text>}{view.status === 'retry' && button(t.retry, () => { void controller.retry(); }, view.busy)}
    <Text accessibilityLiveRegion="polite">{view.status === 'retry' ? t.retryStatus : t[view.status]}</Text>{view.error && <Text>{t.error}</Text>}<Text>{t.ram}</Text>
  </ScrollView>;
}
