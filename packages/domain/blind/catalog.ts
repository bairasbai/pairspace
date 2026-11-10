/** Public, non-personal built-in catalog. Selection is always explicit. */
export const blindQuestion = Object.freeze({
  id: 'small-joy', catalogVersion: 1,
  ru: 'Какая маленькая радость сделала бы сегодняшний день приятнее?',
  en: 'What small joy would make today nicer?',
});
export const blindQuestions = Object.freeze([
  blindQuestion,
  Object.freeze({ id: 'shared-plan', catalogVersion: 1,
    ru: 'Какое небольшое совместное занятие хотелось бы запланировать?',
    en: 'What small activity would you like to plan together?' }),
  Object.freeze({ id: 'kind-memory', catalogVersion: 1,
    ru: 'Какой тёплый совместный момент приятно вспомнить?',
    en: 'What warm moment together is pleasant to remember?' }),
]);
export function findBlindQuestion(id: unknown, version: unknown) {
  return blindQuestions.find(question => question.id === id && question.catalogVersion === version);
}
