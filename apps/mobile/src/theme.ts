import { Platform } from 'react-native';

// Kimi ccbe5df: paper, warm surface, ink, blush and terracotta.
// Interactive accent is darker than the decorative accent for text contrast.
export const colors = {
  background: '#F8F5EF',
  surface: '#FFFDF9',
  ink: '#292324',
  muted: '#655750',
  accent: '#94452F',
  decorativeAccent: '#CF573B',
  border: '#E4D9CE',
  paperDeep: '#EFE8DF',
  blush: '#F3DED3',
  letter: '#FFF8E9',
};
export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radii = { control: 12, card: 20, hero: 24 };
// No remote font loading. Cormorant/Manrope from the web are not bundled yet.
export function displayFontFor(platform: string): string {
  return platform === 'ios' ? 'Georgia' : 'serif';
}
export const typography = {
  display: { fontFamily: displayFontFor(Platform.OS), fontSize: 34, lineHeight: 42 },
  card: { fontFamily: displayFontFor(Platform.OS), fontSize: 24, lineHeight: 32 },
};
