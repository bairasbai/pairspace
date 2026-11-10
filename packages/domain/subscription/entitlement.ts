/** Pure billing policy. This never authenticates a user or authorizes a resource. */
export type PairStatus = 'waiting_partner' | 'active' | 'closed';
export type SubscriptionState = 'pending' | 'active' | 'expired' | 'revoked';
export type SubscriptionSnapshot = Readonly<{
  coupleId: string;
  state: SubscriptionState;
  /** UTC epoch milliseconds supplied by a trusted application adapter. */
  periodStart: number;
  paidThrough: number;
  /** Cancellation of future renewal does not shorten an already paid period. */
  cancelAtPeriodEnd: boolean;
}>;
export type EntitlementContext = Readonly<{
  coupleId: string;
  pairStatus: PairStatus;
  serverNow: number;
  subscription: SubscriptionSnapshot | null;
}>;
export type Entitlement = Readonly<{
  premium: boolean;
  reason: 'active' | 'pair_inactive' | 'no_subscription' | 'different_pair'
    | 'not_active' | 'invalid_time' | 'not_started' | 'expired';
  validUntil: number | null;
}>;

export function evaluateEntitlement(context: EntitlementContext): Entitlement {
  const deny = (reason: Entitlement['reason']): Entitlement => ({ premium: false, reason, validUntil: null });
  if (context.pairStatus !== 'active') return deny('pair_inactive');
  const subscription = context.subscription;
  if (subscription === null) return deny('no_subscription');
  if (!context.coupleId || subscription.coupleId !== context.coupleId) return deny('different_pair');
  if (subscription.state !== 'active') return deny('not_active');
  const { periodStart, paidThrough } = subscription;
  if (![context.serverNow, periodStart, paidThrough].every(Number.isSafeInteger)
    || periodStart >= paidThrough) return deny('invalid_time');
  if (context.serverNow < periodStart) return deny('not_started');
  if (context.serverNow >= paidThrough) return deny('expired');
  return { premium: true, reason: 'active', validUntil: paidThrough };
}

/** These capabilities must never be paywalled. Their existing ACL still applies. */
export const FREE_CAPABILITIES = Object.freeze(['chat', 'chat_history', 'security'] as const);
export type BillingCapability = typeof FREE_CAPABILITIES[number] | 'premium';

/** Unknown capabilities fail closed; premium is a policy marker, not a product feature list. */
export function isAvailableByBilling(capability: BillingCapability, context: EntitlementContext): boolean {
  if (FREE_CAPABILITIES.some(free => free === capability)) return true;
  if (capability !== 'premium') return false;
  return evaluateEntitlement(context).premium;
}
