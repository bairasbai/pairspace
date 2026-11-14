import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import type { Category, Quiet, NotificationView } from './notification-preferences-state';
const copy = {
 ru: { title:'Будущие уведомления', notice:'Push не подключён. Сохраняются только ваши правила будущих уведомлений. Партнёр не видит эти настройки. Текст сообщений не показывается: только общий preview.',
 care:'Думаю о тебе',chat:'Чат',letter:'Письма',quiet:'Тихие часы',start:'Начало HH:mm',end:'Конец HH:mm',timezone:'Пояс тихих часов IANA',
 load:'Загрузить мои правила',edit:'Редактировать проверенные правила',save:'Сохранить мои правила',cancel:'Сбросить форму',retryButton:'Повторить ту же команду',
 check:'Проверить правило сейчас:',unknown:'Правила ещё не проверены.',asOf:'Проверено сервером:',version:'Версия правила:',
 pending:'Есть неизменяемая команда, результат которой ещё не подтверждён.',simulation:'Только проверка сохранённого правила, не событие и не отправка уведомления.',
 allowed:'Правило разрешает уведомление.',disabled:'Категория выключена.',quiet_hours:'Сейчас тихие часы.',
 limits:'Никаких разрешений ОС, push-токенов или доставки. Проверка использует сохранённые правила, не несохранённую форму. Начало тихих часов включено, конец исключён; переход через полночь допустим.',
 idle:'Все категории по умолчанию выключены.',saving:'Сохраняем…',saved:'Личные правила сохранены.',retry:'Результат неизвестен.',invalid:'Проверьте часы и пояс; начало и конец должны различаться. Для изменения загрузите правила в форму.',
 conflict:'Версия изменилась. Загрузите правила и начните редактирование заново.',unavailable:'Правила недоступны.',error:'Не удалось подтвердить состояние.',clear:'Сброс формы не отменяет уже отправленное сохранение.' },
 en: { title:'Future notifications',notice:'Push is not connected. Only your future notification rules are saved. Your partner cannot see these settings. Message text is hidden: generic previews only.',
 care:'Thinking of you',chat:'Chat',letter:'Letters',quiet:'Quiet hours',start:'Start HH:mm',end:'End HH:mm',timezone:'Quiet-hours IANA time zone',
 load:'Load my rules',edit:'Edit checked rules',save:'Save my rules',cancel:'Reset form',retryButton:'Retry same command',
 check:'Check rule now:',unknown:'Rules not checked yet.',asOf:'Server checked at:',version:'Rule version:',
 pending:'An immutable command is awaiting confirmation.',simulation:'Saved-rule simulation only, not an event or notification send.',
 allowed:'The rule permits a notification.',disabled:'Category disabled.',quiet_hours:'Quiet hours are active.',
 limits:'No OS permission, push tokens or delivery. The check uses saved rules, not the unsaved form. Quiet-hour start is inclusive, end exclusive; crossing midnight is supported.',
 idle:'All categories are off by default.',saving:'Saving…',saved:'Private rules saved.',retry:'Outcome unknown.',invalid:'Check times and zone; start and end must differ. Load checked rules into the form to edit.',
 conflict:'Version changed. Load rules and begin editing again.',unavailable:'Rules unavailable.',error:'Could not confirm state.',clear:'Resetting the form does not undo a submitted save.' },
};
export function NotificationPreferencesPanel({locale,view,onCategory,onQuiet,onLoad,onSave,onRetry,onEdit,onCancel,onPreview}:{
 locale:'ru'|'en';view:NotificationView;onCategory(category:Category,enabled:boolean):void;onQuiet(quiet:Quiet|null):void;
 onLoad():void;onSave():void;onRetry():void;onEdit():void;onCancel():void;onPreview(category:Category):void;
}) {
 if(!view.available)return null;
 const t=copy[locale],blocked=view.busy||view.pending!==null||view.requiresRefresh;
 const button=(label:string,action:()=>void,disabled:boolean)=><Pressable accessibilityRole="button" accessibilityState={{disabled,busy:view.busy}} disabled={disabled} onPress={action} style={{minHeight:48,justifyContent:'center'}}><Text>{label}</Text></Pressable>;
 return <View style={{padding:16,gap:8}}><Text accessibilityRole="header">{t.title}</Text><Text>{t.notice}</Text>
  {button(t.load,onLoad,view.busy)}{!view.checked&&<Text>{t.unknown}</Text>}
  {view.asOf&&<Text>{t.asOf} {view.asOf}</Text>}{view.preferences&&<Text>{t.version} {view.preferences.version}</Text>}
  {button(t.edit,onEdit,blocked||!view.checked)}
  {(['care','chat','letter'] as const).map(key=><View key={key}><Text>{t[key]}</Text><Switch accessibilityLabel={t[key]} value={view.fields[key]} onValueChange={enabled=>onCategory(key,enabled)}/>
   {button(`${t.check} ${t[key]}`,()=>onPreview(key),view.busy)}</View>)}
  <Text>{t.quiet}</Text><Switch accessibilityLabel={t.quiet} value={view.fields.quiet!==null} onValueChange={enabled=>onQuiet(enabled?{start:'',end:'',timezone:''}:null)}/>
  {view.fields.quiet&&(['start','end','timezone'] as const).map(key=><TextInput key={key} accessibilityLabel={t[key]} value={view.fields.quiet![key]}
   onChangeText={value=>onQuiet({...view.fields.quiet!,[key]:value})} maxLength={key==='timezone'?100:5} autoCorrect={false} autoCapitalize="none" style={{minHeight:48,padding:8,borderWidth:1}}/>)}
  {button(t.save,onSave,blocked)}{button(t.cancel,onCancel,false)}<Text>{t.clear}</Text>
  {view.pending&&<Text>{t.pending}</Text>}{view.status==='retry'&&button(t.retryButton,onRetry,view.busy)}
  <Text accessibilityLiveRegion="polite">{t[view.status]}</Text>{view.error&&<Text>{t.error}</Text>}
  {view.policyPreview&&<View><Text>{t.simulation}</Text><Text>{t[view.policyPreview.category]} · {t[view.policyPreview.reason]}</Text>
   <Text>{t.version} {view.policyPreview.preferenceVersion} · {t.asOf} {view.policyPreview.asOf}</Text></View>}
  <Text>{t.limits}</Text></View>;
}
