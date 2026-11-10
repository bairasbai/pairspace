import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Copy } from './copy';
import { HeartButton } from './HeartButton';
import { colors } from './theme';

export type Tab = 'today' | 'chat' | 'together' | 'us';
type Props = { selected: Tab; onSelect: (tab: Tab) => void; onHeart: () => void; text: Copy; heart?: { hint: string; disabled: boolean; busy: boolean } };

export function Navigation({ selected, onSelect, onHeart, text, heart }: Props) {
  const tab = (id: Tab) => (
    <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: selected === id }}
      onPress={() => onSelect(id)} style={[styles.tab, selected === id && styles.activeTab]}>
      <Text style={[styles.label, selected === id && styles.selected]}>{text[id]}</Text>
    </Pressable>
  );
  return <View style={styles.bar}>
    {tab('today')}{tab('chat')}
    <HeartButton label={text.heart} hint={heart?.hint ?? text.heartHint} disabled={heart?.disabled} busy={heart?.busy} onPress={onHeart} />
    {tab('together')}{tab('us')}
  </View>;
}
const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface, alignItems: 'stretch' },
  tab: { flex: 1, minHeight: 72, alignItems: 'center', justifyContent: 'center', padding: 4 },
  activeTab: { borderTopWidth: 3, borderTopColor: colors.accent, backgroundColor: colors.paperDeep },
  label: { fontSize: 12, textAlign: 'center', color: colors.muted },
  selected: { color: colors.accent, fontWeight: '700' },
});
