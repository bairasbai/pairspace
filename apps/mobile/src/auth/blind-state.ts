import { blindQuestion } from '../../../../packages/domain/blind/catalog';
import { normalizeAnswer } from '../../../../packages/domain/blind/answer';
import type { SessionContext } from './context';
import { record, uuid } from './tasks-state';
export type BlindRound = Readonly<{ id: string; coupleId: string; membershipEpoch: number;
  questionId: string; catalogVersion: number; ownAnswer: string | null; partnerAnswer: string | null; revealed: boolean }>;
export type BlindView = Readonly<{ available: boolean; busy: boolean; draft: string; consent: boolean;
  round: BlindRound | null; checked: boolean; pending: 'open' | 'answer' | null;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict'; error: boolean; requiresRefresh: boolean }>;
export const emptyBlind: BlindView = { available: false, busy: false, draft: '', consent: false,
  round: null, checked: false, pending: null, status: 'idle', error: false, requiresRefresh: false };
export function validRound(v: unknown, context: SessionContext): v is BlindRound {
  if (!record(v) || context.state !== 'ready' || Object.keys(v).sort().join(',') !==
    'catalogVersion,coupleId,id,membershipEpoch,ownAnswer,partnerAnswer,questionId,revealed') return false;
  const validAnswer = (body: unknown) => { const n = normalizeAnswer(body); return n.ok && n.text === body; };
  return uuid(v.id) && v.coupleId === context.coupleId && v.membershipEpoch === context.membershipEpoch
    && v.questionId === blindQuestion.id && v.catalogVersion === blindQuestion.catalogVersion && typeof v.revealed === 'boolean'
    && (v.ownAnswer === null || validAnswer(v.ownAnswer))
    && (v.revealed ? validAnswer(v.ownAnswer) && validAnswer(v.partnerAnswer) : v.partnerAnswer === null);
}
