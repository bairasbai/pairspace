import { createMorningDiscussionV2Handler } from './morning-discussion-v2-http.ts';
import { createMorningDiscussionsHandler } from './morning-discussions-http.ts';
import { createMorningsHandler } from './morning-http.ts';
import { createChatReconciliationHandler } from './chat-reconciliation-http.ts';
import { visibilityResponse } from './chat-visibility-scope.ts';
import { createChatVisibilityHandler } from './chat-visibility-http.ts';
import { createChatEditingHandler } from './chat-editing-http.ts';
import { createChatDeletionHandler } from './chat-deletion-http.ts';
import { createChatRepliesHandler } from './chat-replies-http.ts';
import { createChatWindowHandler, windowFailure } from './chat-history-window-http.ts';
import { createSharedWishesHandler } from './shared-wishes-http.ts';
import { createSharedSongsHandler } from './shared-songs-http.ts';
import { createSharedMemoriesHandler } from './shared-memories-http.ts';
import { createStemsHandler } from './stems-http.ts';
import { createDayScaleHandler } from './day-scale-http.ts';
import { createAsksHandler } from './asks-http.ts';
import { createStoriesHandler } from './stories-http.ts';
import { createSharedDoingsHandler } from './shared-doings-http.ts';
import { createHardQuestionsHandler } from './hard-questions-http.ts';
import { createLoveWordsHandler } from './love-words-http.ts';
import { createNotificationPreferencesHandler } from './notification-preferences-http.ts';
import { createArrivalPlanHandler } from './arrival-plan-http.ts';
import { createPartingsHandler } from './partings-http.ts';
import { createSharedDatesHandler } from './shared-dates-http.ts';
import { createBlindAnswersHandler } from './blind-answers-http.ts';
import { createSharedTasksHandler } from './shared-tasks-http.ts';
import { createPairLeaveHandler } from './pair-leave-http.ts';
import { createLettersHandler } from './letters-http.ts';
import { createCareSignalHandler } from './care-signals-http.ts';
import { betterAuth } from 'better-auth';
import type { Pool } from 'pg';
import { bindSessionAuthority } from './auth-authority.ts';
import { createBetterAuthAuthority } from './better-auth-authority.ts';
import { createChatHandler } from './http.ts';
import { createSessionContextHandler } from './session-context.ts';
import { createProfileProvisionHandler } from './profile-provision.ts';
import { createPairAcceptanceHandler } from './pair-acceptance.ts';
import { createPairInvitationHandler } from './pair-invitations.ts';
import { createWaitingSpaceHandler } from './waiting-space.ts';
import { createPostgresDatabase, type TransactionLimits } from './postgres-database.ts';
import { limitRequestBody, RequestLimitError, type BodyLimits } from './request-limits.ts';

export type ApiApplicationConfig = Readonly<{
  pool: Pool;
  baseURL: string;
  secret: string;
  trustedOrigins: readonly string[];
  emailPasswordEnabled: boolean;
  /** Test-only opt-in. Allowed only with an explicit loopback baseURL. */
  enableSyntheticProfileProvisioning?: boolean;
  /** Independent test-only opt-in, default disabled, loopback only. */
  enableSyntheticWaitingSpaceCreation?: boolean;
  /** Independent synthetic invitation issuance/revoke opt-in, loopback only. */
  enableSyntheticPairInvitations?: boolean;
  /** Independent synthetic invitation preview/accept opt-in, loopback only. */
  enableSyntheticPairAcceptance?: boolean;
  /** Test-only fixed care signals; independent opt-in, loopback only. */
  enableSyntheticCareSignals?: boolean;
  /** Immutable immediate/scheduled synthetic letters; independent loopback-only opt-in. */
  enableSyntheticLetters?: boolean;
  /** Explicit synthetic active-pair closure; default disabled, loopback only. */
  enableSyntheticPairLeave?: boolean;
  /** Explicit synthetic wishes; independent loopback-only opt-in. */
  enableSyntheticSharedWishes?: boolean;
  /** Synthetic shared tasks; independent loopback-only opt-in. */
  enableSyntheticSharedTasks?: boolean;
  /** Immutable all-day synthetic dates; independent loopback-only opt-in. */
  enableSyntheticSharedDates?: boolean;
  enableSyntheticPartings?: boolean;
  enableSyntheticArrivalPlan?: boolean;
  enableSyntheticNotificationPreferences?: boolean;
  enableSyntheticLoveWords?: boolean;
  enableSyntheticAsks?: boolean;
  /** Short topic and long narrative; independent default-off loopback-only opt-in. */
  enableSyntheticStories?: boolean;
  /** Consent-gated authored questions; independent default-off loopback-only opt-in. */
  enableSyntheticHardQuestions?: boolean;
  /** Synthetic shared doings; independent loopback-only opt-in. */
  enableSyntheticSharedDoings?: boolean;
  enableSyntheticDayScale?: boolean;
  enableSyntheticStems?: boolean;
  /** Explicit shared text memories; independent loopback-only opt-in. */
  enableSyntheticSharedMemories?: boolean;
  /** Explicit shared songs and reasons; independent loopback-only opt-in. */
  enableSyntheticSharedSongs?: boolean;
  /** Repeatable synthetic blind-answer rounds; independent loopback-only opt-in. */
  enableSyntheticBlindAnswers?: boolean;
  /** Synthetic bounded chat windows; independent loopback-only opt-in. */
  enableSyntheticChatHistoryWindow?: boolean;
  /** Synthetic reply-aware chat routes, default disabled, loopback only. */
  enableSyntheticChatReplies?: boolean;
  /** Explicit own-message deletion, independent loopback-only opt-in. */
  enableSyntheticChatDeletion?: boolean;
  /** Explicit own-message editing, independent loopback-only opt-in. */
  enableSyntheticChatEditing?: boolean;
  enableSyntheticChatVisibility?: boolean;
  enableSyntheticChatReconciliation?: boolean;
  enableSyntheticMornings?: boolean;
  enableSyntheticMorningDiscussions?: boolean;
  enableSyntheticMorningDiscussionEditing?: boolean;
  limits: BodyLimits & TransactionLimits;
}>;
export type ApiApplication = Readonly<{ handle(request: Request): Promise<Response> }>;
const failure = (status: number, error: string) => Response.json({ ok: false, error }, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'GET, POST' } : {}) },
});
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;

function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('*') || /\p{Cc}/u.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash
      && ((url.protocol === 'https:' || url.protocol === 'http:') ? url.origin === value
        : /^[a-z][a-z0-9+.-]*:\/\/$/i.test(value));
  } catch { return false; }
}

function validate(config: ApiApplicationConfig): void {
  if (!config || !config.pool || typeof config.pool.connect !== 'function'
    || !validOrigin(config.baseURL) || !/^https?:/.test(config.baseURL)
    || typeof config.secret !== 'string' || config.secret.length < 32 || config.secret.length > 512
    || /\p{Cc}/u.test(config.secret) || typeof config.emailPasswordEnabled !== 'boolean'
    || (config.enableSyntheticProfileProvisioning !== undefined && typeof config.enableSyntheticProfileProvisioning !== 'boolean')
    || (config.enableSyntheticWaitingSpaceCreation !== undefined && typeof config.enableSyntheticWaitingSpaceCreation !== 'boolean')
    || (config.enableSyntheticPairInvitations !== undefined && typeof config.enableSyntheticPairInvitations !== 'boolean')
    || (config.enableSyntheticPairAcceptance !== undefined && typeof config.enableSyntheticPairAcceptance !== 'boolean')
    || (config.enableSyntheticCareSignals !== undefined && typeof config.enableSyntheticCareSignals !== 'boolean')
    || (config.enableSyntheticLetters !== undefined && typeof config.enableSyntheticLetters !== 'boolean')
    || (config.enableSyntheticPairLeave !== undefined && typeof config.enableSyntheticPairLeave !== 'boolean')
    || (config.enableSyntheticBlindAnswers !== undefined && typeof config.enableSyntheticBlindAnswers !== 'boolean')
    || (config.enableSyntheticSharedSongs !== undefined && typeof config.enableSyntheticSharedSongs !== 'boolean')
    || (config.enableSyntheticSharedMemories !== undefined && typeof config.enableSyntheticSharedMemories !== 'boolean')
    || (config.enableSyntheticStems !== undefined && typeof config.enableSyntheticStems !== 'boolean')
    || (config.enableSyntheticDayScale !== undefined && typeof config.enableSyntheticDayScale !== 'boolean')
    || (config.enableSyntheticAsks !== undefined && typeof config.enableSyntheticAsks !== 'boolean')
    || (config.enableSyntheticStories !== undefined && typeof config.enableSyntheticStories !== 'boolean')
    || (config.enableSyntheticHardQuestions !== undefined && typeof config.enableSyntheticHardQuestions !== 'boolean')
    || (config.enableSyntheticSharedDoings !== undefined && typeof config.enableSyntheticSharedDoings !== 'boolean')
    || (config.enableSyntheticLoveWords !== undefined && typeof config.enableSyntheticLoveWords !== 'boolean')
    || (config.enableSyntheticNotificationPreferences !== undefined && typeof config.enableSyntheticNotificationPreferences !== 'boolean')
    || (config.enableSyntheticArrivalPlan !== undefined && typeof config.enableSyntheticArrivalPlan !== 'boolean')
    || (config.enableSyntheticPartings !== undefined && typeof config.enableSyntheticPartings !== 'boolean')
    || (config.enableSyntheticSharedDates !== undefined && typeof config.enableSyntheticSharedDates !== 'boolean')
    || (config.enableSyntheticSharedWishes !== undefined && typeof config.enableSyntheticSharedWishes !== 'boolean')
    || (config.enableSyntheticSharedTasks !== undefined && typeof config.enableSyntheticSharedTasks !== 'boolean')
    || (config.enableSyntheticChatHistoryWindow !== undefined && typeof config.enableSyntheticChatHistoryWindow !== 'boolean')
    || (config.enableSyntheticChatReplies !== undefined && typeof config.enableSyntheticChatReplies !== 'boolean')
    || (config.enableSyntheticChatDeletion !== undefined && typeof config.enableSyntheticChatDeletion !== 'boolean')
    || (config.enableSyntheticMorningDiscussionEditing !== undefined && typeof config.enableSyntheticMorningDiscussionEditing !== 'boolean')
    || (config.enableSyntheticMorningDiscussions !== undefined && typeof config.enableSyntheticMorningDiscussions !== 'boolean')
    || (config.enableSyntheticMornings !== undefined && typeof config.enableSyntheticMornings !== 'boolean')
    || (config.enableSyntheticChatReconciliation !== undefined && typeof config.enableSyntheticChatReconciliation !== 'boolean')
    || (config.enableSyntheticChatVisibility !== undefined && typeof config.enableSyntheticChatVisibility !== 'boolean')
    || (config.enableSyntheticChatEditing !== undefined && typeof config.enableSyntheticChatEditing !== 'boolean')
    || !Array.isArray(config.trustedOrigins) || !config.trustedOrigins.length
    || !config.trustedOrigins.every(validOrigin) || !config.trustedOrigins.includes(config.baseURL)
    || !config.limits || !integer(config.limits.bodyBytes, 65536) || !integer(config.limits.bodyReadMs, 30000)
    || !integer(config.limits.statementMs, 30000) || !integer(config.limits.lockMs, config.limits.statementMs)) {
    throw new Error('invalid_api_configuration');
  }
  const base = new URL(config.baseURL);
  if ((base.protocol === 'http:' || config.enableSyntheticProfileProvisioning === true || config.enableSyntheticWaitingSpaceCreation === true
    || config.enableSyntheticPairInvitations === true || config.enableSyntheticPairAcceptance === true || config.enableSyntheticCareSignals === true || config.enableSyntheticLetters === true || config.enableSyntheticPairLeave === true || config.enableSyntheticSharedSongs === true || config.enableSyntheticSharedMemories === true || config.enableSyntheticStems === true || config.enableSyntheticDayScale === true || config.enableSyntheticAsks === true || config.enableSyntheticStories === true || config.enableSyntheticHardQuestions === true || config.enableSyntheticSharedDoings === true || config.enableSyntheticLoveWords === true || config.enableSyntheticNotificationPreferences === true || config.enableSyntheticArrivalPlan === true || config.enableSyntheticPartings === true || config.enableSyntheticSharedDates === true || config.enableSyntheticSharedWishes === true || config.enableSyntheticSharedTasks === true || config.enableSyntheticBlindAnswers === true || config.enableSyntheticChatHistoryWindow === true || config.enableSyntheticChatReplies === true || config.enableSyntheticChatDeletion === true || config.enableSyntheticChatEditing === true || config.enableSyntheticChatVisibility === true || config.enableSyntheticChatReconciliation === true || config.enableSyntheticMornings === true || config.enableSyntheticMorningDiscussions === true || config.enableSyntheticMorningDiscussionEditing === true)
    && !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)) {
    throw new Error('invalid_api_configuration');
  }
}

/** Construction creates no listener, migrations, mappings, accounts or environment-based credentials. */
export function createApiApplication(config: ApiApplicationConfig): ApiApplication {
  validate(config);
  const origins = new Set(config.trustedOrigins);
  const limits = { ...config.limits };
  const auth = betterAuth({
    database: config.pool, baseURL: config.baseURL, basePath: '/api/auth',
    secret: config.secret, secrets: [{ version: 1, value: config.secret }],
    trustedOrigins: [...origins], emailAndPassword: { enabled: config.emailPasswordEnabled },
    session: { cookieCache: { enabled: false } },
    logger: { disabled: true }, telemetry: { enabled: false }, onAPIError: { throw: true },
  });
  const database = createPostgresDatabase(config.pool, limits);
  const authOptions = {
    getSession: (headers: Headers) => auth.api.getSession({ headers }), trustedOrigins: [...origins],
  };
  const authority = createBetterAuthAuthority(database, authOptions);
  const context = createSessionContextHandler(database, authOptions);
  const profile = config.enableSyntheticProfileProvisioning === true
    ? createProfileProvisionHandler(database, authOptions) : null;
  const waiting = config.enableSyntheticWaitingSpaceCreation === true
    ? createWaitingSpaceHandler(database, authOptions) : null;
  const invitation = config.enableSyntheticPairInvitations === true
    ? createPairInvitationHandler(database, authOptions) : null;
  const acceptance = config.enableSyntheticPairAcceptance === true
    ? createPairAcceptanceHandler(database, authOptions) : null;
  const care = config.enableSyntheticCareSignals === true ? createCareSignalHandler(bindSessionAuthority(database, authority)) : null;
  const letters = config.enableSyntheticLetters === true ? createLettersHandler(bindSessionAuthority(database, authority)) : null;
  const leave = config.enableSyntheticPairLeave === true ? createPairLeaveHandler(bindSessionAuthority(database, authority)) : null;
  const songs = config.enableSyntheticSharedSongs === true ? createSharedSongsHandler(bindSessionAuthority(database, authority)) : null;
  const memories = config.enableSyntheticSharedMemories === true ? createSharedMemoriesHandler(bindSessionAuthority(database, authority)) : null;
  const stems = config.enableSyntheticStems === true ? createStemsHandler(bindSessionAuthority(database, authority)) : null;
  const dayScale = config.enableSyntheticDayScale === true ? createDayScaleHandler(bindSessionAuthority(database, authority)) : null;
  const asks = config.enableSyntheticAsks === true ? createAsksHandler(bindSessionAuthority(database, authority)) : null;
  const stories = config.enableSyntheticStories === true ? createStoriesHandler(bindSessionAuthority(database, authority)) : null;
  const sharedDoings = config.enableSyntheticSharedDoings === true ? createSharedDoingsHandler(bindSessionAuthority(database, authority)) : null;
  const hardQuestions = config.enableSyntheticHardQuestions === true ? createHardQuestionsHandler(bindSessionAuthority(database, authority)) : null;
  const loveWords = config.enableSyntheticLoveWords === true ? createLoveWordsHandler(bindSessionAuthority(database, authority)) : null;
  const notificationPreferences = config.enableSyntheticNotificationPreferences === true ? createNotificationPreferencesHandler(bindSessionAuthority(database, authority)) : null;
  const arrivalPlan = config.enableSyntheticArrivalPlan === true ? createArrivalPlanHandler(bindSessionAuthority(database, authority)) : null;
  const partings = config.enableSyntheticPartings === true ? createPartingsHandler(bindSessionAuthority(database, authority)) : null;
  const dates = config.enableSyntheticSharedDates === true ? createSharedDatesHandler(bindSessionAuthority(database, authority)) : null;
  const wishes = config.enableSyntheticSharedWishes === true ? createSharedWishesHandler(bindSessionAuthority(database, authority)) : null;
  const tasks = config.enableSyntheticSharedTasks === true ? createSharedTasksHandler(bindSessionAuthority(database, authority)) : null;
  const blind = config.enableSyntheticBlindAnswers === true ? createBlindAnswersHandler(bindSessionAuthority(database, authority)) : null;
  const morningDiscussionEditing = config.enableSyntheticMorningDiscussionEditing === true ? createMorningDiscussionV2Handler(bindSessionAuthority(database, authority)) : null;
  const morningDiscussions = config.enableSyntheticMorningDiscussions === true ? createMorningDiscussionsHandler(bindSessionAuthority(database, authority)) : null;
  const mornings = config.enableSyntheticMornings === true ? createMorningsHandler(bindSessionAuthority(database, authority)) : null;
  const chatDb=bindSessionAuthority(database,authority);
  const visibility=config.enableSyntheticChatVisibility===true?visibilityResponse(chatDb,createChatVisibilityHandler):null;
  const chatWindow = config.enableSyntheticChatHistoryWindow === true ? visibilityResponse(chatDb, createChatWindowHandler) : null;
  const replyWindow = config.enableSyntheticChatReplies === true ? visibilityResponse(chatDb, bound=>createChatWindowHandler(bound,true)) : null;
  const replies = config.enableSyntheticChatReplies === true ? visibilityResponse(chatDb, createChatRepliesHandler) : null;
  const deletion = config.enableSyntheticChatDeletion === true ? visibilityResponse(chatDb, createChatDeletionHandler) : null;
  const editing = config.enableSyntheticChatEditing === true ? visibilityResponse(chatDb, createChatEditingHandler) : null;
  const reconciliation = config.enableSyntheticChatReconciliation === true ? visibilityResponse(chatDb, createChatReconciliationHandler) : null;
  const chat = visibilityResponse(chatDb, createChatHandler);
  return {
    async handle(request) {
      const path = new URL(request.url).pathname;
      const isMorningDiscussionEditing = /^\/v1\/couples\/[^/]+\/mornings\/slots\/[^/]+\/discussion-v2(?:\/[^/]+)?$/.test(path) && morningDiscussionEditing !== null;
      const isMorningDiscussions = /^\/v1\/couples\/[^/]+\/mornings\/slots\/[^/]+\/discussion$/.test(path) && morningDiscussions !== null;
      const isMornings = /^\/v1\/couples\/[^/]+\/mornings(?:\/.*)?$/.test(path) && mornings !== null;
      const isReconciliation = /^\/v1\/couples\/[^/]+\/chat\/reconcile$/.test(path) && reconciliation !== null;
      const isVisibility=/^\/v1\/couples\/[^/]+\/chat\/(hidden-window|messages\/[^/]+\/(hidden|visibility))$/.test(path) && visibility!==null;
      const isEditing = /^\/v1\/couples\/[^/]+\/chat\/messages\/[^/]+$/.test(path) && editing !== null && request.method === 'PATCH';
      const isDeletion = /^\/v1\/couples\/[^/]+\/chat\/messages\/[^/]+$/.test(path) && deletion !== null;
      const isReplyWindow = /^\/v1\/couples\/[^/]+\/chat\/reply-window$/.test(path) && replyWindow !== null;
      const isReply = /^\/v1\/couples\/[^/]+\/chat\/(replies|message-detail)$/.test(path) && replies !== null;
      const isReplyRead = isReply && path.endsWith('/message-detail');
      const isWindow = /^\/v1\/couples\/[^/]+\/chat\/history-window$/.test(new URL(request.url).pathname) && chatWindow !== null;
      const reject = (status: number, error: string) => (((isMornings || isMorningDiscussions || isMorningDiscussionEditing) && request.method === 'GET') || isReconciliation || isWindow || isReplyWindow || isReplyRead || (isVisibility && request.method==='GET')) ? windowFailure(request, status, error) : failure(status, error);
      try {
        const path = new URL(request.url).pathname;
        const isAuth = path.startsWith('/api/auth/');
        const isChat = /^\/v1\/couples\/[^/]+\/chat\/messages$/.test(path);
        const isCare = /^\/v1\/couples\/[^/]+\/care-signals$/.test(path) && care !== null;
        const isLetters = /^\/v1\/couples\/[^/]+\/letters(?:\/[^/]+)?$/.test(path) && letters !== null;
        const isSongs = /^\/v1\/couples\/[^/]+\/songs(?:\/[^/]+)?$/.test(path) && songs !== null;
        const isMemories = /^\/v1\/couples\/[^/]+\/memories$/.test(path) && memories !== null;
        const isStems = /^\/v1\/couples\/[^/]+\/stems(?:\/[^/]+\/(?:complete|skip|author-bundle|recipient-continuation))?$/.test(path) && stems !== null;
        const isDayScale = /^\/v1\/couples\/[^/]+\/day-scale(?:\/[^/]+)?$/.test(path) && dayScale !== null;
        const isAsks = /^\/v1\/couples\/[^/]+\/asks(?:\/[^/]+\/(?:answer|skip|question))?$/.test(path) && asks !== null;
        const isStories = /^\/v1\/couples\/[^/]+\/stories(?:\/[^/]+\/(?:story|decline|topic|text))?$/.test(path) && stories !== null;
        const isSharedDoings = /^\/v1\/couples\/[^/]+\/shared-doings(?:\/[^/]+(?:\/(?:join|decline|advance))?)?$/.test(path) && sharedDoings !== null;
        const isHardQuestions = /^\/v1\/couples\/[^/]+\/hard-questions(?:\/[^/]+(?:\/(?:open|decline|text))?)?$/.test(path) && hardQuestions !== null;
        const isLoveWords = /^\/v1\/couples\/[^/]+\/love-words(?:\/[^/]+)?$/.test(path) && loveWords !== null;
        const isNotificationPreferences = /^\/v1\/couples\/[^/]+\/notification-preferences(?:\/preview)?$/.test(path) && notificationPreferences !== null;
        const isArrivalPlan = /^\/v1\/couples\/[^/]+\/arrival-plan$/.test(path) && arrivalPlan !== null;
        const isPartings = /^\/v1\/couples\/[^/]+\/partings(?:\/[^/]+)?$/.test(path) && partings !== null;
        const isPartingEdit = isPartings && request.method === 'PATCH';
        const isDates = /^\/v1\/couples\/[^/]+\/dates(?:\/[^/]+)?$/.test(path) && dates !== null;
        const isSongEdit = isSongs && /^\/v1\/couples\/[^/]+\/songs\/[^/]+$/.test(path) && request.method === 'PATCH';
        const isDateEdit = isDates && /^\/v1\/couples\/[^/]+\/dates\/[^/]+$/.test(path) && request.method === 'PATCH';
        const isWishes = /^\/v1\/couples\/[^/]+\/wishes(?:\/[^/]+)?$/.test(path) && wishes !== null;
        const isTasks = /^\/v1\/couples\/[^/]+\/tasks(?:\/[^/]+)?$/.test(path) && tasks !== null;
        const isBlind = /^\/v1\/couples\/[^/]+\/(?:blind-round(?:\/[^/]+\/answer)?|blind-rounds(?:\/[^/]+)?)$/.test(path) && blind !== null;
        const isContext = path === '/v1/session/context';
        const isProfile = path === '/v1/profile' && profile !== null;
        const isWaiting = path === '/v1/spaces/waiting' && waiting !== null;
        const isInvitation = path === '/v1/spaces/waiting/invite' && invitation !== null;
        const isAcceptance = ['/v1/pair-invitations/preview', '/v1/pair-invitations/accept'].includes(path) && acceptance !== null;
        const isLeave = path === '/v1/pair/leave' && leave !== null;
        const mutation = isLeave ? leave : isAcceptance ? acceptance : isInvitation ? invitation : isProfile ? profile : isWaiting ? waiting : null;
        if (!isMorningDiscussionEditing && !isMorningDiscussions && !isMornings && !isReconciliation && !isVisibility && !isEditing && !isDeletion && !isReply && !isReplyWindow && !isWindow && !isAuth && !isChat && !isCare && !isLetters && !isTasks && !isWishes && !isStems && !isDayScale && !isAsks && !isStories && !isSharedDoings && !isHardQuestions && !isLoveWords && !isNotificationPreferences && !isArrivalPlan && !isPartings && !isDates && !isSongs && !isMemories && !isBlind && !isContext && !mutation) return reject(404, 'not_found');
        if (!isMorningDiscussionEditing && !isMornings && !isVisibility && !isEditing && !isDeletion && !isContext && !mutation && !isStems && !isDayScale && !isAsks && !isStories && !isSharedDoings && !isHardQuestions && !isLoveWords && !isNotificationPreferences && !isArrivalPlan && !isPartingEdit && !isDateEdit && !isSongEdit && request.method !== 'GET' && request.method !== 'POST') return reject(405, 'method_not_allowed');
        const origin = request.headers.get('origin') ?? request.headers.get('expo-origin');
        if (!origin || !origins.has(origin)) return reject(403, 'forbidden');
        if (isContext) return context(request);
        if (mutation && !isInvitation && request.method !== 'POST') return mutation(request);
        if ((request.method === 'POST' || (isStems && request.method === 'DELETE') || (isDayScale && (request.method === 'PUT' || request.method === 'DELETE')) || (isAsks && request.method === 'DELETE') || (isStories && request.method === 'DELETE') || (isSharedDoings && request.method === 'DELETE') || (isHardQuestions && request.method === 'DELETE') || (isLoveWords && (request.method === 'PUT' || request.method === 'DELETE')) || (isMorningDiscussionEditing && (request.method==='PATCH' || request.method==='DELETE')) || ((isMornings || isNotificationPreferences || isArrivalPlan) && request.method === 'PUT') || (isVisibility && request.method==='PUT') || isEditing || (isDeletion && request.method === 'DELETE') || isPartingEdit || isDateEdit || isSongEdit || (isInvitation && request.method === 'DELETE'))
          && request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return reject(415, 'unsupported_media_type');
        }
        const bounded = await limitRequestBody(request, limits);
        const response = await (isStems ? stems!(bounded) : isDayScale ? dayScale!(bounded) : isAsks ? asks!(bounded) : isSharedDoings ? sharedDoings!(bounded) : isHardQuestions ? hardQuestions!(bounded) : isStories ? stories!(bounded) : isLoveWords ? loveWords!(bounded) : isMorningDiscussionEditing ? morningDiscussionEditing!(bounded) : isMorningDiscussions ? morningDiscussions!(bounded) : isMornings ? mornings!(bounded) : isReconciliation ? reconciliation!(bounded) : isVisibility ? visibility!(bounded) : isEditing ? editing!(bounded) : isDeletion ? deletion!(bounded) : isReply ? replies!(bounded) : isReplyWindow ? replyWindow!(bounded) : isWindow ? chatWindow!(bounded) : mutation ? mutation(bounded) : isAuth ? auth.handler(bounded) : isCare ? care!(bounded) : isLetters ? letters!(bounded) : isBlind ? blind!(bounded) : isSongs ? songs!(bounded) : isMemories ? memories!(bounded) : isNotificationPreferences ? notificationPreferences!(bounded) : isArrivalPlan ? arrivalPlan!(bounded) : isPartings ? partings!(bounded) : isDates ? dates!(bounded) : isWishes ? wishes!(bounded) : isTasks ? tasks!(bounded) : chat(bounded));
        if (response.status >= 500) return reject(503, 'temporarily_unavailable');
        const headers = new Headers(response.headers);
        headers.set('cache-control', 'no-store'); headers.set('x-content-type-options', 'nosniff');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      } catch (error) {
        return error instanceof RequestLimitError ? reject(error.status, 'invalid_request') : reject(503, 'temporarily_unavailable');
      }
    },
  };
}
