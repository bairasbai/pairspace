import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Locale } from './copy';
import { showcaseCopy } from './showcaseCopy';
import { colors } from './theme';

export type Section = 'today' | 'together' | 'letters' | 'calendar' | 'memories';
type Props = { section: Section; locale: Locale; onOpen: (section: Section) => void };
export function Showcase({ section, locale, onOpen }: Props) {
  const t = showcaseCopy[locale];
  const [calendarTab, setCalendarTab] = useState<'plans' | 'tasks'>('plans');
  const link = (target: Section, title: string, detail: string) => <Pressable
    key={target} accessibilityRole="button" accessibilityHint={t.open}
    onPress={() => onOpen(target)} style={styles.link}>
    <Text style={styles.cardTitle}>{title}</Text><Text style={styles.body}>{detail}</Text>
    <Text accessible={false} style={styles.arrow}>↗</Text>
  </Pressable>;
  const planned = (title: string, detail: string) => <View key={title} style={styles.planned}>
    <Text style={styles.cardTitle}>{title}</Text><Text style={styles.body}>{detail}</Text>
    <Text style={styles.tag}>{t.planned}</Text>
  </View>;
  return <View style={styles.container}>
    <Text style={styles.demo}>{t.demo}</Text>
    {section === 'today' && <>
      <Text style={styles.subtitle}>{t.subtitle}</Text>
      <View style={styles.hero}>
        <Text style={styles.body}>{t.meeting}</Text>
        <Text style={styles.countdown}>{t.countdown}</Text>
        <Text style={styles.body}>{t.meetingNote}</Text>
      </View>
      <View style={styles.note}><Text style={styles.cardTitle}>{t.note}</Text><Text style={styles.noteText}>{t.noteText}</Text></View>
      {link('letters', t.letters, t.lettersHint)}
      {link('calendar', t.calendar, t.calendarHint)}
    </>}
    {section === 'together' && <>
      <Text style={styles.subtitle}>{t.activities}</Text>
      {link('letters', t.letters, t.lettersHint)}
      {link('calendar', t.calendar, t.calendarHint)}
      {link('memories', t.memories, t.memoriesHint)}
      {planned(t.dates, t.plannedHint)}
      {planned(t.wishes, t.plannedHint)}
      {planned(t.conversations, t.plannedHint)}
      <Text accessibilityRole="header" style={styles.heading}>{t.games}</Text>
      {planned(t.checkers, t.plannedHint)}{planned(t.battleship, t.plannedHint)}
      {planned(t.support, t.supportHint)}{planned(t.films, t.plannedHint)}
    </>}
    {section === 'letters' && <>
      <Text style={styles.subtitle}>{t.lettersHint}</Text>
      <View style={styles.note}><Text style={styles.cardTitle}>{t.letterTitle}</Text><Text style={styles.noteText}>{t.letterBody}</Text></View>
      {planned(t.future, t.futureHint)}
      <Text style={styles.body}>{t.empty}</Text>
    </>}
    {section === 'calendar' && <>
      <Text style={styles.subtitle}>{t.calendarHint}</Text>
      <View style={styles.segments}>{(['plans', 'tasks'] as const).map(id => <Pressable key={id}
        accessibilityRole="tab" accessibilityState={{ selected: calendarTab === id }}
        onPress={() => setCalendarTab(id)} style={[styles.segment, calendarTab === id && styles.active]}>
        <Text style={calendarTab === id ? styles.activeText : styles.segmentText}>{t[id]}</Text>
      </Pressable>)}</View>
      <View style={styles.note}><Text style={styles.cardTitle}>{calendarTab === 'plans' ? t.samplePlan : t.sampleTask}</Text>
        <Text style={styles.body}>{calendarTab === 'plans' ? t.date : t.plannedHint}</Text></View>
      <Text style={styles.body}>{t.empty}</Text>
    </>}
    {section === 'memories' && <>
      <Text style={styles.subtitle}>{t.memoriesHint}</Text>
      <View style={styles.hero}><Text accessible={false} style={styles.art}>♡</Text>
        <Text style={styles.cardTitle}>{t.memoryTitle}</Text><Text style={styles.body}>{t.memoryText}</Text></View>
      <Text style={styles.body}>{t.empty}</Text>
    </>}
  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 16 },
  demo: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  subtitle: { color: colors.muted, fontSize: 17, lineHeight: 25 },
  hero: { backgroundColor: '#F1D5BF', borderRadius: 24, padding: 24, gap: 12, alignItems: 'center' },
  countdown: { color: colors.ink, fontSize: 44, fontWeight: '600' },
  note: { backgroundColor: '#FFF8ED', borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 20, gap: 12 },
  noteText: { fontSize: 18, lineHeight: 28, fontStyle: 'italic', color: colors.ink },
  body: { color: colors.muted, fontSize: 15, lineHeight: 23 },
  cardTitle: { fontSize: 20, lineHeight: 28, color: colors.ink, fontWeight: '600' },
  heading: { fontSize: 24, color: colors.ink, fontWeight: '600' },
  link: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 20, padding: 20, gap: 8, minHeight: 64 },
  arrow: { color: colors.accent, fontSize: 24, alignSelf: 'flex-end' },
  planned: { padding: 20, borderRadius: 20, backgroundColor: '#F5E7D9', gap: 8 },
  tag: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  segments: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, minHeight: 48, padding: 12, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F5E7D9' },
  active: { backgroundColor: colors.accent },
  activeText: { color: colors.surface, fontSize: 16, fontWeight: '600' },
  segmentText: { color: colors.ink, fontSize: 16 },
  art: { color: colors.accent, fontSize: 80 },
});
