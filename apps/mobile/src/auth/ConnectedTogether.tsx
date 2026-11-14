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
    controller: Pick<SessionController, 'loveWords' | 'asks' | 'scale' | 'stems' | 'stories' | 'hardQuestions' | 'sharedDoings'>;
    locale: 'ru' | 'en';
}) {
    const [selected, setSelected] = useState<'words' | 'asks' | 'scale' | 'stems' | 'stories' | 'hard' | 'doings'>('words');
    const current = (selected === 'doings' && !controller.sharedDoings) || (selected === 'stories' && !controller.stories) || (selected === 'hard' && !controller.hardQuestions) ? 'words' : selected;
    const labels = locale === 'ru' ? { words: 'Словарь', asks: 'Вопросы', scale: 'Шкала дня', stems: 'Продолжи фразу', stories: 'Рассказ по заказу', hard: 'Трудный вопрос', doings: 'Совместное дело' } : { words: 'Dictionary', asks: 'Questions', scale: 'Day scale', stems: 'Continue phrase', stories: 'Ordered stories', hard: 'Hard question', doings: 'Shared doing' };
    return <View style={{ flex: 1 }}>
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
      {(['words', 'asks', 'scale', 'stems', ...(controller.stories ? ['stories' as const] : []), ...(controller.hardQuestions ? ['hard' as const] : []), ...(controller.sharedDoings ? ['doings' as const] : [])] as const).map(tab => <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: current === tab }} onPress={() => setSelected(tab)} style={{ minHeight: 48, flexBasis: '50%', justifyContent: 'center', alignItems: 'center' }}><Text>{labels[tab]}</Text></Pressable>)}
    </View>
    {current === 'doings' && controller.sharedDoings ? <SharedDoingsPanel controller={controller.sharedDoings} locale={locale}/> : current === 'hard' && controller.hardQuestions ? <HardQuestionsPanel controller={controller.hardQuestions} locale={locale}/> : current === 'stories' && controller.stories ? <StoriesPanel controller={controller.stories} locale={locale}/> : current === 'words' ? <LoveWordsPanel controller={controller.loveWords} locale={locale}/> : current === 'asks' ? <AsksPanel controller={controller.asks} locale={locale}/> : current === 'scale' ? <ScalePanel controller={controller.scale} locale={locale}/> : <StemsPanel controller={controller.stems} locale={locale}/>}
  </View>;
}
