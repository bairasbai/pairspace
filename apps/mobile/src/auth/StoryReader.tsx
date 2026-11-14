import { Text, View } from 'react-native';
import type { StoriesView } from './stories-state';
import { storiesCopy } from './storiesCopy';

/** Plain selectable paragraphs, with no links, previews, telemetry or external requests. */
export function StoryReader({ opened, locale, userId }: { opened: NonNullable<StoriesView['opened']>; locale: 'ru' | 'en'; userId: string | null }) {
  const t = storiesCopy[locale];
  return <View style={{ padding: 12, gap: 8, borderWidth: 1 }}>
    <Text accessibilityRole="header">{t.readerTitle}</Text>
    <Text>{t.topicBy} {opened.story.topicAuthorId === userId ? t.you : t.partner}</Text>
    <Text>{opened.story.topicState === 'active' ? opened.story.topic : t.removedTopic}</Text>
    <Text>{t.storyBy} {opened.story.storyAuthorId === userId ? t.you : t.partner}</Text>
    <Text>{t.toldAt} {opened.story.toldAt} {t.timestamp}</Text>
    <Text>{t.readAt} {opened.checkedAt}</Text>
    <Text selectable>{opened.body}</Text>
  </View>;
}
