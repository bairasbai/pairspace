import type { DisplayMessage, ReplySelection } from '../chat/reply-view';
import type { HistoryView } from '../chat/history';
import type { DeleteState } from './chat-delete';
import type { EditState } from './chat-edit';
export type AuthView = Readonly<{
  phase: 'signed_out' | 'busy' | 'signed_in' | 'blocked';
  error: string | null; draft: string; messages: readonly DisplayMessage[];
  replyAttachmentUnavailable?: string;
  replyTarget?: ReplySelection; replyDetail?: DisplayMessage; replyDetailLoading?: boolean; chatSuspended?: boolean;
  history?: HistoryView; visibilityChanged?: boolean; hiddenAcknowledged?: boolean;
  outgoingPending?: boolean;
  discardConfirmation?: Readonly<{ token: string; clientId: string | null; wasInFlight: boolean }>;
  currentUserId?: string; deleteState?: DeleteState; editState?: EditState;
  outgoing?: Readonly<{ body: string; status: 'sending' | 'retry' | 'sent'; replyToId?: string }>;
}>;
