import { ConnectedNavigation } from './src/auth/ConnectedNavigation';
import { useControllerOwner } from './src/auth/useControllerOwner';
import { useState } from 'react';
import { SyntheticChatConnected, type SessionController } from './src/auth/SyntheticChatConnected';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { copy, type Locale } from './src/copy';
import { Navigation, type Tab } from './src/Navigation';
import { PreviewScreen } from './src/PreviewScreen';
import { showcaseCopy } from './src/showcaseCopy';
import { colors, typography } from './src/theme';

export default function App() { return <PairspaceApp />; }

export function PairspaceApp({ syntheticController = null }: { syntheticController?: SessionController | null } = {}) {
  useControllerOwner(syntheticController);
  const [locale, setLocale] = useState<Locale>('ru');
  const [tab, setTab] = useState<Tab>('today');
  const [draft, setDraft] = useState('');
  const text = copy[locale];
  const onHeart = () => Alert.alert(text.heart, text.heartNotice, [{ text: text.close }]);
  return <SafeAreaProvider>
    <SafeAreaView style={styles.root}>
      <Text style={styles.brand}>{showcaseCopy[locale].brand}</Text>
      <Text style={styles.banner}>{syntheticController ? text.connectedPreview : text.preview}</Text>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          {tab === 'chat' && syntheticController ? <SyntheticChatConnected ownsController={false} showCareSend={false} controller={syntheticController} locale={locale} /> : <PreviewScreen key={tab} tab={tab} text={text} locale={locale} setLocale={setLocale} draft={draft} setDraft={setDraft} />}
        {syntheticController ? <ConnectedNavigation controller={syntheticController} locale={locale} selected={tab} onSelect={setTab} />
          : <Navigation selected={tab} onSelect={setTab} onHeart={onHeart} text={text} />}
      </KeyboardAvoidingView>
    </SafeAreaView>
  </SafeAreaProvider>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  brand: { fontFamily: typography.display.fontFamily, color: colors.ink, fontSize: 18, fontWeight: '600', padding: 16, textAlign: 'center' },
  banner: { color: colors.muted, fontSize: 12, textAlign: 'center', paddingHorizontal: 16, paddingBottom: 12 },
});
