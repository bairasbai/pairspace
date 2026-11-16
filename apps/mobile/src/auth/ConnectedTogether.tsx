import { DailyQuestionsPanel } from './DailyQuestionsPanel';
import { DisputesPanel } from './DisputesPanel';
import { CapsulesPanel } from './CapsulesPanel';
import { PredictionsPanel } from './PredictionsPanel';
import { SharedDoingsPanel } from './SharedDoingsPanel';
import { StoriesPanel } from './StoriesPanel';
import { HardQuestionsPanel } from './HardQuestionsPanel';
import {StemsPanel} from './StemsPanel';
import {ScalePanel} from './ScalePanel';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AsksPanel } from './AsksPanel';
import { LoveWordsPanel } from './LoveWordsPanel';
import type { SessionController } from './SyntheticChatConnected';
export function ConnectedTogether({ controller, locale }: {
    controller: Pick<SessionController, 'loveWords' | 'asks' | 'scale' | 'stems' | 'stories' | 'hardQuestions' | 'sharedDoings' | 'predictions' | 'capsules' | 'disputes' | 'dailyQuestions'>;
    locale: 'ru' | 'en';
}) {
    const [selected, setSelected] = useState<'words' | 'asks' | 'scale' | 'stems' | 'stories' | 'hard' | 'doings' | 'predictions' | 'capsules' | 'disputes' | 'dailyQuestions'>('words');
    const current = (selected === 'dailyQuestions' && !controller.dailyQuestions) || (selected === 'disputes' && !controller.disputes) || (selected === 'capsules' && !controller.capsules) || (selected === 'predictions' && !controller.predictions) || (selected === 'doings' && !controller.sharedDoings) || (selected === 'stories' && !controller.stories) || (selected === 'hard' && !controller.hardQuestions) ? 'words' : selected;
    const labels = locale === 'ru' ? { dailyQuestions: 'Вопрос дня', words: 'Словарь', asks: 'Вопросы', scale: 'Шкала дня', stems: 'Продолжи фразу', stories: 'Рассказ по заказу', hard: 'Трудный вопрос', doings: 'Совместное дело', predictions: 'Предсказания', disputes: 'Спор', capsules: 'Личная капсула' } : { dailyQuestions: 'Daily question', words: 'Dictionary', asks: 'Questions', scale: 'Day scale', stems: 'Continue phrase', stories: 'Ordered stories', hard: 'Hard question', doings: 'Shared doing', predictions: 'Predictions', disputes: 'Disagreement', capsules: 'Personal capsule' };
    return <View style={{ flex: 1 }}>
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
      {(['words', 'asks', 'scale', 'stems', ...(controller.stories ? ['stories' as const] : []), ...(controller.hardQuestions ? ['hard' as const] : []), ...(controller.sharedDoings ? ['doings' as const] : []), ...(controller.predictions ? ['predictions' as const] : []), ...(controller.dailyQuestions ? ['dailyQuestions' as const] : []), ...(controller.disputes ? ['disputes' as const] : []), ...(controller.capsules ? ['capsules' as const] : [])] as const).map(tab => <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: current === tab }} onPress={() => setSelected(tab)} style={{ minHeight: 48, flexBasis: '50%', justifyContent: 'center', alignItems: 'center' }}><Text>{labels[tab]}</Text></Pressable>)}
    </View>
    {current === 'dailyQuestions' && controller.dailyQuestions ? <DailyQuestionsPanel controller={controller.dailyQuestions} locale={locale}/> : current === 'disputes' && controller.disputes ? <DisputesPanel controller={controller.disputes} locale={locale}/> : current === 'capsules' && controller.capsules ? <CapsulesPanel controller={controller.capsules} locale={locale}/> : current === 'predictions' && controller.predictions ? <PredictionsPanel controller={controller.predictions} locale={locale}/> : current === 'doings' && controller.sharedDoings ? <SharedDoingsPanel controller={controller.sharedDoings} locale={locale}/> : current === 'hard' && controller.hardQuestions ? <HardQuestionsPanel controller={controller.hardQuestions} locale={locale}/> : current === 'stories' && controller.stories ? <StoriesPanel controller={controller.stories} locale={locale}/> : current === 'words' ? <LoveWordsPanel controller={controller.loveWords} locale={locale}/> : current === 'asks' ? <AsksPanel controller={controller.asks} locale={locale}/> : current === 'scale' ? <ScalePanel controller={controller.scale} locale={locale}/> : <StemsPanel controller={controller.stems} locale={locale}/>}
  </View>;
}
