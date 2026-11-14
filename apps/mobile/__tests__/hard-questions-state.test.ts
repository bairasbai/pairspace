import { canReadQuestion, emptyHard, mergeQuestion } from '../src/auth/hard-questions-state';
import { context, incoming, opened, own, removed, uuid } from './hard-questions-fixtures';
it('merges canonical gaps without claiming completeness and rejects regressions/duplicates/capacity', () => {
  const view = { ...emptyHard, available: true, userId: context.userId, questions: [own], used: 1 };
  const q = { ...incoming, sequence: 3 };
  const merged = mergeQuestion(view, q); expect(merged.used).toBe(3); expect(merged.questions).toHaveLength(2);
  expect(() => mergeQuestion(view, { ...own, sequence: 2 })).toThrow('invalid_hard_question_revision');
  expect(() => mergeQuestion(view, incoming)).toThrow('invalid_hard_question_revision');
  const full = Array.from({ length: 100 }, (_, n) => ({ ...own, id: uuid(100+n), sequence: n+1 }));
  expect(() => mergeQuestion({ ...view, questions: full }, { ...own, id: uuid(999), sequence: 100 })).toThrow();
  const reader = { question: opened, text: 'Synthetic question', checkedAt: '2026-11-11T00:00:00.000Z' };
  const readView = { ...view, questions: [opened], reader };
  expect(mergeQuestion(readView, opened).reader).toBe(reader);
  expect(mergeQuestion(readView, removed).reader).toBeNull();
  expect(canReadQuestion(own, context.userId)).toBe(true); expect(canReadQuestion(incoming, context.userId)).toBe(false);
});
