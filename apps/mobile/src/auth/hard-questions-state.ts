import { normalizeHardText } from '../../../../packages/domain/hard/text';
import { canReadQuestion, exact, followsQuestion, instant, orderQuestions, record, uuid, validQuestion, type HardQuestion } from '../../../../packages/domain/hard/metadata';
export { normalizeHardText, canReadQuestion, exact, followsQuestion, instant, orderQuestions, record, uuid, validQuestion };
export type { HardQuestion };
export type HardView = Readonly<{
  generation: number; available: boolean; userId: string | null; busy: boolean;
  checked: boolean; checkedAt: string | null; questions: readonly HardQuestion[]; used: number; capacity: 100;
  draft: string; reader: Readonly<{ question: HardQuestion; text: string; checkedAt: string }> | null;
  readerStatus: 'closed' | 'loading' | 'opened' | 'changed' | 'error';
  pending: boolean; requiresRefresh: boolean; error: boolean;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable' | 'limit';
}>;
export const emptyHard: HardView = Object.freeze({ generation: 0, available: false, userId: null, busy: false,
  checked: false, checkedAt: null, questions: [], used: 0, capacity: 100, draft: '', reader: null,
  readerStatus: 'closed', pending: false, requiresRefresh: false, error: false, status: 'idle' });
/** Single-record ACK/detail can leave history gaps; only full GET certifies it. */
export function mergeQuestion(view: HardView, next: HardQuestion): Pick<HardView, 'questions' | 'used' | 'reader'> {
  const old = view.questions.find(q => q.id === next.id);
  if ((old && !followsQuestion(old, next)) || view.questions.some(q => q.id !== next.id && q.sequence === next.sequence)
    || (!old && view.questions.length >= 100)) throw Error('invalid_hard_question_revision');
  const questions = [...view.questions.filter(q => q.id !== next.id), next].sort(orderQuestions);
  const reader = view.reader && view.reader.question.id === next.id
    && (view.reader.question.version !== next.version || !canReadQuestion(next, view.userId!)) ? null : view.reader;
  return { questions, used: Math.max(view.used, next.sequence), reader };
}
