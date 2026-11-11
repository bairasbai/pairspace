import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { normalizeSongLink } from '../../../../packages/domain/songs/link';
import { songsCopy } from './songsCopy';
/** Only a direct user press asks the OS to open a validated public HTTPS URL.
 * No canOpenURL preflight, fetch, clipboard write or automatic retry. */
export function SongLink({ url, locale }: { url: string; locale: 'ru' | 'en' }) {
  const active = useRef(true), opening = useRef(false);
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>('idle');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const t = songsCopy[locale];
  if (!normalizeSongLink(url).ok) return null;
  const supported = Platform.OS === 'ios' || Platform.OS === 'android';
  async function open() {
    if (!active.current || opening.current || !supported) return;
    opening.current = true; setState('opening');
    try { await Linking.openURL(url); if (active.current) setState('idle'); }
    catch { if (active.current) setState('failed'); }
    finally { opening.current = false; }
  }
  return <View>
    <Text>{url}</Text><Text>{t.leaving}</Text>
    {supported ? <Pressable accessibilityRole="button" disabled={state === 'opening'}
      accessibilityState={{ disabled: state === 'opening', busy: state === 'opening' }}
      onPress={() => { void open(); }} style={{ minHeight: 48, justifyContent: 'center' }}>
      <Text>{t.openLink}</Text>
    </Pressable> : <Text>{t.openUnsupported}</Text>}
    {state === 'failed' && <Text accessibilityLiveRegion="polite">{t.openFailed}</Text>}
  </View>;
}
