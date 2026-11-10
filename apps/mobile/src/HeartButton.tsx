import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { colors } from './theme';
import { useReducedMotion } from './useReducedMotion';

type Props = { label: string; hint: string; onPress: () => void; disabled?: boolean; busy?: boolean };

export function HeartButton({ label, hint, onPress, disabled = false, busy = false }: Props) {
  const reduced = useReducedMotion();
  const [scale] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduced) {
      scale.setValue(1);
      return;
    }
    const pulse = Animated.loop(Animated.sequence([
      Animated.timing(scale, { toValue: 1.06, duration: 1100, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 1100, useNativeDriver: true }),
    ]));
    pulse.start();
    return () => { pulse.stop(); scale.setValue(1); };
  }, [reduced, scale]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}
      disabled={disabled || busy} accessibilityState={{ disabled: disabled || busy, busy }}
      onPress={onPress} style={styles.button}>
      <Animated.View style={[styles.circle, { transform: [{ scale }] }]}>
        <Text accessible={false} style={styles.heart}>♥</Text>
      </Animated.View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}
const styles = StyleSheet.create({
  button: { flex: 1.4, alignItems: 'center', justifyContent: 'center', minHeight: 72, padding: 4 },
  circle: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  heart: { color: colors.surface, fontSize: 28 },
  label: { color: colors.accent, fontSize: 11, textAlign: 'center', marginTop: 4 },
});
