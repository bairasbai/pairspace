import { findBlindQuestion } from '../../../../packages/domain/blind/catalog';
import { normalizeAnswer } from '../../../../packages/domain/blind/answer';
import type { SessionContext } from './context';
import { record, uuid } from './tasks-state';
export type BlindRound = Readonly<{ id: string; coupleId: string; membershipEpoch: number;
  questionId: string; catalogVersion: number; ownAnswer: string | null; partnerAnswer: string | null; revealed: boolean }>;
export type BlindView = Readonly<{ available: boolean; busy: boolean; draft: string; consent: boolean;
  round: BlindRound | null; checked: boolean; pending: 'open' | 'answer' | 'next' | null;
  selectedRoundId: string | null; currentRoundId: string | null; rounds: readonly RoundSummary[];
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict'; error: boolean; requiresRefresh: boolean }>;
export const emptyBlind: BlindView = { available: false, busy: false, draft: '', consent: false,
  selectedRoundId: null, currentRoundId: null, rounds: [], round: null, checked: false, pending: null, status: 'idle', error: false, requiresRefresh: false };
export function validRound(v: unknown, context: SessionContext): v is BlindRound {
  if (!record(v) || context.state !== 'ready' || Object.keys(v).sort().join(',') !==
    'catalogVersion,coupleId,id,membershipEpoch,ownAnswer,partnerAnswer,questionId,revealed') return false;
  const validAnswer = (body: unknown) => { const n = normalizeAnswer(body); return n.ok && n.text === body; };
  return uuid(v.id) && v.coupleId === context.coupleId && v.membershipEpoch === context.membershipEpoch
    && typeof v.questionId === 'string' && typeof v.catalogVersion === 'number' && !!findBlindQuestion(v.questionId, v.catalogVersion) && typeof v.revealed === 'boolean'
    && (v.ownAnswer === null || validAnswer(v.ownAnswer))
    && (v.revealed ? validAnswer(v.ownAnswer) && validAnswer(v.partnerAnswer) : v.partnerAnswer === null);
}

export type RoundSummary = Readonly<{ id: string; questionId: string; catalogVersion: number }>;
export type RoundWindow = Readonly<{ currentRoundId: string | null; rounds: readonly RoundSummary[]; limit: 10 }>;
export function validWindow(v: unknown): v is RoundWindow {
  if (!record(v) || Object.keys(v).sort().join(',') !== 'currentRoundId,limit,rounds'
    || v.limit !== 10 || !Array.isArray(v.rounds) || v.rounds.length > 10) return false;
  const ids = new Set<string>();
  for (const item of v.rounds) {
    if (!record(item) || Object.keys(item).sort().join(',') !== 'catalogVersion,id,questionId'
      || !uuid(item.id) || ids.has(item.id) || typeof item.questionId !== 'string'
      || typeof item.catalogVersion !== 'number' || !findBlindQuestion(item.questionId, item.catalogVersion)) return false;
    ids.add(item.id);
  }
  return v.rounds.length === 0 ? v.currentRoundId === null
    : typeof v.currentRoundId === 'string' && v.rounds[0].id === v.currentRoundId;
}
