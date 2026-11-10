import { colors, displayFontFor, spacing } from '../src/theme';

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
it('uses available platform serif fallbacks without remote fonts', () => {
  expect(displayFontFor('ios')).toBe('Georgia');
  expect(displayFontFor('android')).toBe('serif');
  expect(displayFontFor('web')).toBe('serif');
});
it('keeps readable text contrast on all warm surfaces', () => {
  for (const background of [colors.background, colors.surface, colors.paperDeep, colors.blush, colors.letter]) {
    for (const foreground of [colors.ink, colors.muted, colors.accent]) {
      expect((luminance(background) + 0.05) / (luminance(foreground) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect((luminance(colors.surface) + 0.05) / (luminance(colors.accent) + 0.05)).toBeGreaterThanOrEqual(4.5);
});
it('retains the Kimi paper identity and consistent spacing', () => {
  expect(colors.background).toBe('#F8F5EF');
  expect(colors.surface).toBe('#FFFDF9');
  expect(colors.ink).toBe('#292324');
  expect(Object.values(spacing).every(value => value % 4 === 0)).toBe(true);
});
