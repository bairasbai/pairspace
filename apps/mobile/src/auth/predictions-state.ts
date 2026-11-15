import { acknowledgePrediction, declinePrediction, followsPrediction, mayReadPrediction, normalizePredictionBody,
  parsePredictionSchedule, removePrediction, validPrediction, type Prediction } from '../../../../packages/domain/predictions/policy';
import { exact, instant, record, uuid } from '../../../../packages/domain/hard/metadata';
export { acknowledgePrediction, declinePrediction, followsPrediction, normalizePredictionBody, parsePredictionSchedule, removePrediction, validPrediction, exact, instant, record, uuid };
export type { Prediction };
export type { PredictionsActions } from './predictions';
export type PredictionScheduleInput = Readonly<{ localDate: string; localTime: string; timezone: string; offset: string }>;
export type PredictionView = Readonly<{
  generation: number; available: boolean; userId: string | null; busy: boolean;
  checked: boolean; checkedAt: string | null; predictions: readonly Prediction[]; used: number; capacity: 100;
  draft: string; schedule: PredictionScheduleInput;
  reader: Readonly<{ prediction: Prediction; text: string; checkedAt: string }> | null;
  readerStatus: 'closed' | 'loading' | 'opened' | 'changed' | 'error';
  pending: boolean; requiresRefresh: boolean; error: boolean;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable' | 'limit' | 'not_due';
}>;
export const emptyPredictionSchedule: PredictionScheduleInput = Object.freeze({ localDate: '', localTime: '', timezone: '', offset: '' });
export const emptyPredictions: PredictionView = Object.freeze({ generation: 0, available: false, userId: null, busy: false,
  checked: false, checkedAt: null, predictions: Object.freeze([]), used: 0, capacity: 100, draft: '', schedule: emptyPredictionSchedule,
  reader: null, readerStatus: 'closed', pending: false, requiresRefresh: false, error: false, status: 'idle' });
export function canReadPrediction(prediction: Prediction, userId: string | null, checkedAt: string | null): boolean {
  return userId !== null && checkedAt !== null && mayReadPrediction(prediction,
    { coupleId: prediction.coupleId, membershipEpoch: prediction.membershipEpoch, userId }, checkedAt);
}
export const predictionOrder = (a: Prediction, b: Prediction) => a.createdAt === b.createdAt
  ? (a.id === b.id ? 0 : a.id > b.id ? -1 : 1) : a.createdAt > b.createdAt ? -1 : 1;
/** No SQL sequence is exposed. A single ACK/detail cannot certify complete history. */
export function mergePrediction(view: PredictionView, next: Prediction, checkedAt: string): Pick<PredictionView, 'predictions' | 'used' | 'reader'> {
  const scope = { coupleId: next.coupleId, membershipEpoch: next.membershipEpoch, userId: view.userId! };
  const old = view.predictions.find(q => q.id === next.id);
  if (!validPrediction(next, scope) || (old && !followsPrediction(old, next, scope)) || (!old && view.predictions.length >= 100)) throw Error('invalid_prediction_revision');
  const predictions = [...view.predictions.filter(q => q.id !== next.id), next].sort(predictionOrder);
  const reader = view.reader && (!canReadPrediction(view.reader.prediction, view.userId, checkedAt)
    || (view.reader.prediction.id === next.id && (view.reader.prediction.version !== next.version || !canReadPrediction(next, view.userId, checkedAt)))) ? null : view.reader;
  return { predictions, used: Math.max(view.used, predictions.length), reader };
}
