import { Text, View } from 'react-native';
import type { HardView } from './hard-questions-state';
import { hardQuestionsCopy } from './hardQuestionsCopy';
export function HardQuestionReader({ reader, userId, locale }: { reader: NonNullable<HardView['reader']>; userId: string | null; locale: 'ru' | 'en' }) {
  const t = hardQuestionsCopy[locale];
  return <View style={{ borderWidth: 1, padding: 12, gap: 8 }}>
    <Text accessibilityRole="header">{t.readerTitle}</Text>
    <Text>{reader.question.authorId === userId ? t.ownView : t.openedView}</Text>
    <Text>{t.author} {reader.question.authorId === userId ? t.you : t.partner}</Text>
    <Text>{t.createdAt} {reader.question.createdAt}</Text>
    {reader.question.openedAt && <Text>{t.openedAt} {reader.question.openedAt}</Text>}
    <Text>{t.checkedTextAt} {reader.checkedAt}</Text>
    <Text selectable>{reader.text}</Text>
  </View>;
}
