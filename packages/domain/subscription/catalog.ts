/** Versioned reference prices, not a checkout or a promise of store availability. */
export const SUBSCRIPTION_CATALOG = Object.freeze({
  version: '2026-11-10.v1',
  plans: Object.freeze({
    monthly: Object.freeze({ code: 'monthly', interval: 'month', amountMinor: 29900, currency: 'RUB', people: 2 }),
    annual: Object.freeze({ code: 'annual', interval: 'year', amountMinor: 249000, currency: 'RUB', people: 2 }),
  }),
} as const);
export type SubscriptionPlan = keyof typeof SUBSCRIPTION_CATALOG.plans;
