import { blindQuestion } from '../../../../packages/domain/blind/catalog';
export const blindCopy = {
  ru: {
    verifyCurrent: 'Обновите список раундов, чтобы подтвердить текущий раунд и продолжить.', history: 'Обновить список раундов', window: 'Последние 10 раундов, не полная история. Выберите раунд, чтобы прочитать ответы.', current: 'Текущий раунд', next: 'Подтвердить новый раунд с вопросом:', title: 'Слепые ответы', question: blindQuestion.ru,
    notice: 'Новый раунд можно начать после раскрытия текущего, только с вашим подтверждением. Ответы открываются друг другу только после отправки обоих. Статус ответа партнёра не показывается. Можно не отвечать. Черновик хранится только в памяти устройства. Сервер может читать отправленный текст; это не E2EE.',
    open: 'Открыть раунд', read: 'Обновить раунд', draft: 'Мой приватный черновик',
    consent: 'Я согласен открыть ответ партнёру после отправки обоих ответов. В этой версии отправленный ответ нельзя изменить или удалить.',
    submit: 'Подтвердить и отправить ответ', again: 'Повторить тот же запрос', own: 'Мой отправленный ответ', partner: 'Ответ партнёра',
    hidden: 'Ответы ещё не раскрыты. Обновите раунд, когда будете готовы.',
    idle: '', saving: 'Отправляем…', retry: 'Результат запроса неизвестен. Повторите тот же запрос.',
    saved: 'Раунд обновлён.', invalid: 'Введите корректный ответ до 1000 символов.',
    conflict: 'Состояние изменилось. Обновите список раундов и выберите текущий раунд.', error: 'Не удалось проверить раунд. Попробуйте снова.',
  },
  en: {
    verifyCurrent: 'Refresh the round list to confirm the current round and continue.', history: 'Refresh round list', window: 'Latest 10 rounds, not the complete history. Select a round to read answers.', current: 'Current round', next: 'Confirm new round with question:', title: 'Blind answers', question: blindQuestion.en,
    notice: 'After the current round is revealed, you can explicitly confirm another round. Answers become visible to each other only after both submit. Your partner’s submission status is not shown. You can choose not to answer. Drafts live only in device memory. The server can read submitted text; this is not E2EE.',
    open: 'Open round', read: 'Refresh round', draft: 'My private draft',
    consent: 'I agree to reveal my answer to my partner after both submit. In this version, a submitted answer cannot be edited or deleted.',
    submit: 'Confirm and submit answer', again: 'Retry the same request', own: 'My submitted answer', partner: 'Partner’s answer',
    hidden: 'Answers are not revealed yet. Refresh the round when you are ready.',
    idle: '', saving: 'Submitting…', retry: 'The request outcome is unknown. Retry the same request.',
    saved: 'Round updated.', invalid: 'Enter a valid answer up to 1000 characters.',
    conflict: 'The state changed. Refresh the round list and select the current round.', error: 'Could not check the round. Please try again.',
  },
};
