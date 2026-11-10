import { useEffect, useState } from 'react';
import { Showcase, type Section } from './Showcase';
import { showcaseCopy } from './showcaseCopy';
import { Alert, BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Copy, Locale } from './copy';
import type { Tab } from './Navigation';
import { colors } from './theme';

type Props = { tab: Tab; text: Copy; locale: Locale; setLocale: (locale: Locale) => void; draft: string; setDraft: (value: string) => void };
export function PreviewScreen({ tab, text, locale, setLocale, draft, setDraft }: Props) {
  const [detail, setDetail] = useState<Section | null>(null);
  useEffect(() => {
    if (!detail) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setDetail(null);
      return true;
    });
    return () => subscription.remove();
  }, [detail]);
  const t = showcaseCopy[locale];
  const title = detail === 'letters' || detail === 'calendar' || detail === 'memories' ? t[detail] : text[tab];
  const clearDraft = () => Alert.alert(text.confirmClear, text.clearInfo, [
    { text: text.cancel, style: 'cancel' },
    { text: text.delete, style: 'destructive', onPress: () => setDraft('') },
  ]);
  return <ScrollView key={detail ?? tab} testID={`screen-scroll-${detail ?? tab}`}
    contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
    {detail && <Pressable accessibilityRole="button" onPress={() => setDetail(null)} style={styles.action}><Text style={styles.actionText}>{t.back}</Text></Pressable>}
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    {detail ? <Showcase section={detail} locale={locale} onOpen={setDetail} /> : <>
    {(tab === 'today' || tab === 'together') && <Showcase section={tab} locale={locale} onOpen={setDetail} />}
    {tab === 'chat' && <View style={styles.card}>
      <Text style={styles.paragraph}>{text.chatInfo}</Text>
      <Text style={styles.label}>{text.draft}</Text>
      <TextInput accessibilityLabel={text.draft} placeholder={text.placeholder}
        placeholderTextColor={colors.muted} value={draft} onChangeText={setDraft}
        multiline maxLength={2000} autoCorrect={false} style={styles.input} />
      <Text style={styles.paragraph}>{text.limit}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !draft }}
        disabled={!draft} onPress={clearDraft} style={styles.action}>
        <Text style={[styles.actionText, !draft && styles.disabled]}>{text.clear}</Text>
      </Pressable>
    </View>}
    {tab === 'us' && <View style={styles.card}>
      <Pressable accessibilityRole="button" onPress={() => setDetail('memories')} style={styles.action}><Text style={styles.actionText}>{t.memories}</Text></Pressable>
      <Text style={styles.paragraph}>{text.settingsInfo}</Text>
      <Text style={styles.label}>{text.language}</Text>
      {(['ru', 'en'] as const).map(code => <Pressable key={code} accessibilityRole="radio"
        accessibilityState={{ checked: code === locale }} onPress={() => setLocale(code)} style={styles.action}>
        <Text style={styles.actionText}>{code === 'ru' ? 'Русский' : 'English'}</Text>
      </Pressable>)}
      <Text style={styles.paragraph}>{text.privacy}</Text>
    </View>}
    </>}
  </ScrollView>;
}
const styles = StyleSheet.create({
  body: { padding: 20, gap: 20, flexGrow: 1 },
  title: { fontSize: 30, color: colors.ink, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: 20, padding: 20, gap: 16 },
  paragraph: { color: colors.muted, fontSize: 16, lineHeight: 24 },
  label: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  input: { color: colors.ink, fontSize: 17, minHeight: 144, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 },
  action: { minHeight: 48, padding: 12, justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  actionText: { color: colors.accent, fontWeight: '600', fontSize: 16 },
  disabled: { color: colors.muted },
});
