import { Button, Text, View } from 'react-native';
import type { AuthView } from './auth-view';
export const outgoingAttemptCopy = {
    ru: {
        begin: 'Убрать локальную попытку отправки', cancel: 'Продолжить ждать', confirm: 'Убрать только локальную попытку',
        warning: 'Это не удалит сообщение у партнёра и не отменит отправку. Если результат неизвестен, сообщение уже могло быть отправлено. После подтверждения повтор этой попытки будет недоступен; сначала проверьте чат, чтобы не отправить дубликат. Неизменённый текст этой отправки и выбранный для него ответ будут очищены; новый черновик останется.',
    },
    en: {
        begin: 'Discard local send attempt', cancel: 'Keep waiting', confirm: 'Discard only the local attempt',
        warning: 'This does not delete your partner’s message or cancel delivery. If the outcome is unknown, the message may already have been sent. Confirming removes this attempt’s retry option; check the chat before sending a duplicate. The unchanged submitted text and its reply selection will be cleared; a newer draft will be kept.',
    },
};
export function OutgoingAttemptPanel({ locale, pending, confirmation, onBegin, onCancel, onConfirm }: {
    locale: 'ru' | 'en';
    pending?: boolean;
    confirmation?: AuthView['discardConfirmation'];
    onBegin(): void;
    onCancel(): void;
    onConfirm(token: string): void;
}) {
    if (!pending)
        return null;
    const t = outgoingAttemptCopy[locale];
    return <View><Button title={t.begin} onPress={onBegin}/>
    {confirmation && <View><Text accessibilityRole="alert">{t.warning}</Text>
      <Button title={t.cancel} onPress={onCancel}/>
      <Button title={t.confirm} onPress={() => onConfirm(confirmation.token)}/>
    </View>}
  </View>;
}
