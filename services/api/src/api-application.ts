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
    || !Array.isArray(config.trustedOrigins) || !config.trustedOrigins.length
    || !config.trustedOrigins.every(validOrigin) || !config.trustedOrigins.includes(config.baseURL)
    || !config.limits || !integer(config.limits.bodyBytes, 65536) || !integer(config.limits.bodyReadMs, 30000)
    || !integer(config.limits.statementMs, 30000) || !integer(config.limits.lockMs, config.limits.statementMs)) {
    throw new Error('invalid_api_configuration');
  }
  const base = new URL(config.baseURL);
  if ((base.protocol === 'http:' || config.enableSyntheticProfileProvisioning === true || config.enableSyntheticWaitingSpaceCreation === true
    || config.enableSyntheticPairInvitations === true || config.enableSyntheticPairAcceptance === true || config.enableSyntheticCareSignals === true)
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
  const chat = createChatHandler(bindSessionAuthority(database, authority));
  return {
    async handle(request) {
      try {
        const path = new URL(request.url).pathname;
        const isAuth = path.startsWith('/api/auth/');
        const isChat = /^\/v1\/couples\/[^/]+\/chat\/messages$/.test(path);
        const isCare = /^\/v1\/couples\/[^/]+\/care-signals$/.test(path) && care !== null;
        const isContext = path === '/v1/session/context';
        const isProfile = path === '/v1/profile' && profile !== null;
        const isWaiting = path === '/v1/spaces/waiting' && waiting !== null;
        const isInvitation = path === '/v1/spaces/waiting/invite' && invitation !== null;
        const isAcceptance = ['/v1/pair-invitations/preview', '/v1/pair-invitations/accept'].includes(path) && acceptance !== null;
        const mutation = isAcceptance ? acceptance : isInvitation ? invitation : isProfile ? profile : isWaiting ? waiting : null;
        if (!isAuth && !isChat && !isCare && !isContext && !mutation) return failure(404, 'not_found');
        if (!isContext && !mutation && request.method !== 'GET' && request.method !== 'POST') return failure(405, 'method_not_allowed');
        const origin = request.headers.get('origin') ?? request.headers.get('expo-origin');
        if (!origin || !origins.has(origin)) return failure(403, 'forbidden');
        if (isContext) return context(request);
        if (mutation && !isInvitation && request.method !== 'POST') return mutation(request);
        if ((request.method === 'POST' || (isInvitation && request.method === 'DELETE'))
          && request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return failure(415, 'unsupported_media_type');
        }
        const bounded = await limitRequestBody(request, limits);
        const response = await (mutation ? mutation(bounded) : isAuth ? auth.handler(bounded) : isCare ? care!(bounded) : chat(bounded));
        if (response.status >= 500) return failure(503, 'temporarily_unavailable');
        const headers = new Headers(response.headers);
        headers.set('cache-control', 'no-store'); headers.set('x-content-type-options', 'nosniff');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      } catch (error) {
        return error instanceof RequestLimitError ? failure(error.status, 'invalid_request') : failure(503, 'temporarily_unavailable');
      }
    },
  };
}
