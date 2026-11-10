import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_CATALOG } from '../../../packages/domain/subscription/catalog.ts';
import { evaluateEntitlement, FREE_CAPABILITIES, isAvailableByBilling,
  type BillingCapability, type EntitlementContext, type SubscriptionSnapshot } from '../../../packages/domain/subscription/entitlement.ts';

const paid: SubscriptionSnapshot = {
  coupleId: 'synthetic-pair-a', state: 'active', periodStart: 1000, paidThrough: 2000, cancelAtPeriodEnd: false,
};
const context: EntitlementContext = { coupleId: paid.coupleId, pairStatus: 'active', serverNow: 1500, subscription: paid };
const withSubscription = (change: Partial<SubscriptionSnapshot>): EntitlementContext => ({ ...context, subscription: { ...paid, ...change } });

describe('immutable pair price catalogue', () => {
  it('contains the approved versioned RUB prices for two people', () => {
    expect(SUBSCRIPTION_CATALOG).toEqual({ version: '2026-11-10.v1', plans: {
      monthly: { code: 'monthly', interval: 'month', amountMinor: 29900, currency: 'RUB', people: 2 },
      annual: { code: 'annual', interval: 'year', amountMinor: 249000, currency: 'RUB', people: 2 },
    } });
    for (const object of [SUBSCRIPTION_CATALOG, SUBSCRIPTION_CATALOG.plans, ...Object.values(SUBSCRIPTION_CATALOG.plans)]) {
      expect(Object.isFrozen(object)).toBe(true);
      expect(() => Object.defineProperty(object, 'unexpected', { value: true })).toThrow(TypeError);
    }
  });
});

describe('pure entitlement evaluation', () => {
  it.each([1000, 1500, 1999])('allows only inside the paid interval (%i)', serverNow => {
    expect(evaluateEntitlement({ ...context, serverNow })).toEqual({ premium: true, reason: 'active', validUntil: 2000 });
  });
  it.each([2000, 2001])('expires at the exclusive upper boundary (%i)', serverNow => {
    expect(evaluateEntitlement({ ...context, serverNow }).reason).toBe('expired');
  });
  it('denies before the inclusive lower boundary', () => expect(evaluateEntitlement({ ...context, serverNow: 999 }).reason).toBe('not_started'));
  it.each(['closed', 'waiting_partner'] as const)('denies %s pairs', pairStatus => {
    expect(evaluateEntitlement({ ...context, pairStatus }).reason).toBe('pair_inactive');
  });
  it('denies a missing subscription', () => expect(evaluateEntitlement({ ...context, subscription: null }).reason).toBe('no_subscription'));
  it.each(['synthetic-pair-b', ''])('does not transfer to another or empty pair id (%s)', coupleId => {
    expect(evaluateEntitlement({ ...context, coupleId }).reason).toBe('different_pair');
  });
  it.each(['pending', 'expired', 'revoked'] as const)('denies %s despite a future paid-through date', state => {
    expect(evaluateEntitlement(withSubscription({ state })).reason).toBe('not_active');
  });
  it.each([NaN, Infinity, -Infinity, 1000.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe time %s', value => {
    for (const invalid of [{ ...context, serverNow: value }, withSubscription({ periodStart: value }), withSubscription({ paidThrough: value })]) {
      expect(evaluateEntitlement(invalid)).toEqual({ premium: false, reason: 'invalid_time', validUntil: null });
    }
  });
  it.each([1000, 999])('rejects empty or reversed intervals (%i)', paidThrough => {
    expect(evaluateEntitlement(withSubscription({ paidThrough })).reason).toBe('invalid_time');
  });
  it('does not treat cancellation of future renewal as revocation', () => {
    expect(evaluateEntitlement(withSubscription({ cancelAtPeriodEnd: true }))).toEqual(evaluateEntitlement(context));
  });
  it('is deterministic, does not mutate inputs and never extends the period', () => {
    const frozen = Object.freeze({ ...context, subscription: Object.freeze({ ...paid }) });
    expect(evaluateEntitlement(frozen)).toEqual(evaluateEntitlement(frozen));
    expect(frozen.subscription).toEqual(paid);
  });
});

describe('billing is separate from resource authorization', () => {
  it('never gates chat, history or security on subscription or pair state', () => {
    const cases = [context, { ...context, subscription: null }, { ...context, pairStatus: 'closed' as const },
      { ...context, serverNow: NaN }, { ...context, coupleId: 'synthetic-pair-b' },
      ...(['pending', 'expired', 'revoked'] as const).map(state => withSubscription({ state }))];
    for (const input of cases) for (const feature of FREE_CAPABILITIES) expect(isAvailableByBilling(feature, input)).toBe(true);
    expect(Object.isFrozen(FREE_CAPABILITIES)).toBe(true);
  });
  it('checks premium and rejects unknown capability names', () => {
    expect(isAvailableByBilling('premium', context)).toBe(true);
    expect(isAvailableByBilling('premium', { ...context, serverNow: 2000 })).toBe(false);
    expect(isAvailableByBilling('unknown' as BillingCapability, context)).toBe(false);
  });
});
