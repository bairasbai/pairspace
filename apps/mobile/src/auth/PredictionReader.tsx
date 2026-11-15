import { Text, View } from 'react-native';
import type { PredictionView } from './predictions-state';
import { predictionsCopy } from './predictionsCopy';
export function PredictionReader({ reader, userId, locale }: { reader: NonNullable<PredictionView['reader']>; userId: string | null; locale: 'ru' | 'en' }) {
  const t = predictionsCopy[locale];
  return <View style={{ borderWidth: 1, padding: 12, gap: 8 }}>
    <Text accessibilityRole="header">{t.readerTitle}</Text>
    <Text>{reader.prediction.authorId === userId ? t.ownView : t.openedView}</Text>
    <Text>{t.author} {reader.prediction.authorId === userId ? t.you : t.partner}</Text>
    <Text>{t.createdAt} {reader.prediction.createdAt}</Text>
    <Text>{t.release} {reader.prediction.localDate} {reader.prediction.localTime} {reader.prediction.timezone} {reader.prediction.offset}</Text>
    <Text>{t.utc} {reader.prediction.releaseAt}</Text>
    {reader.prediction.openedAt && <Text>{t.openedAt} {reader.prediction.openedAt}</Text>}
    <Text>{t.checkedTextAt} {reader.checkedAt}</Text><Text selectable>{reader.text}</Text>
  </View>;
}
