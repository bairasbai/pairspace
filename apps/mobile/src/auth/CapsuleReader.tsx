import { Text, View } from 'react-native';
import { canReadCapsule, type CapsuleView } from './capsules-state';
import { capsulesCopy } from './capsulesCopy';
import { colors, radii, spacing } from '../theme';
export function CapsuleReader({ reader, userId, locale }: { reader: NonNullable<CapsuleView['reader']>; userId: string | null; locale: 'ru' | 'en' }) {
  const t = capsulesCopy[locale], capsule = reader.capsule;
  if (!canReadCapsule(capsule, userId, reader.checkedAt)) return null;
  return <View style={{ backgroundColor: colors.letter, borderRadius: radii.card, padding: spacing.md, gap: spacing.sm }}>
    <Text accessibilityRole="header" style={{ color: colors.ink }}>{t.readerTitle}</Text>
    <Text style={{ color: colors.muted }}>{t.release} {capsule.localDate} {capsule.localTime} {capsule.timezone} {capsule.offset}</Text>
    <Text style={{ color: colors.muted }}>{t.checkedTextAt} {reader.checkedAt}</Text>
    <Text selectable style={{ color: colors.ink, fontSize: 18, lineHeight: 28 }}>{reader.text}</Text>
  </View>;
}
