# Subscription domain checkpoint, 10 November 2026

## Implemented scope
Pure TypeScript catalogue and billing eligibility only. No SDK, payment, provider
adapter, event processor, database migration, purchase, restore or UI integration.
Reference price catalogue `2026-11-10.v1`: 299 RUB per month or 2490 RUB per year
for two people. Amounts use integer kopeks; catalogue and nested plans are frozen.
Future price revisions must use a new version, not mutate this catalogue.

## Contract
`evaluateEntitlement` accepts a trusted server-side snapshot and explicit UTC epoch
milliseconds. It grants premium only for the same active couple with an active
subscription and `periodStart <= serverNow < paidThrough`. Invalid integer times,
empty/reversed periods, missing subscriptions and inactive pairs deny premium.
A cancellation of future renewal does not shorten an already paid period.
The result describes billing eligibility only; it authenticates nobody and does
not establish that a snapshot came from a verified provider. Clients must never
be allowed to supply these trusted values to an authorization decision.

`isAvailableByBilling` always permits the billing layer for chat, chat history and
security, regardless of subscription state or billing availability. Existing ACL,
authentication, closed-pair archive policy and security checks remain mandatory.
The `premium` capability is only a generic policy marker. No product feature is
newly classified as paid by this change. Unknown capabilities fail closed.

## Explicit boundaries
- No automatic transfer between couples: couple IDs must match.
- No automatic reopening of a closed couple, restoration or data deletion.
- Subscription snapshots are singular inputs. Enforcing one active subscription
  per pair, ownership and concurrency requires a future transactional backend.
- No account/payer ownership, renewal, restoration, refund, grace-period,
  provider-event idempotency or out-of-order processing implementation.
- Payer transfer after breakup, renewal cancellation after breakup, paid feature
  list and former-member archive access still require product decisions.
- Payer status must never confer access to private resources or an old partner.

## Verification
Synthetic fixtures cover exact time boundaries, invalid times, inactive pairs,
cross-pair denial, cancellation, immutability and unconditional free capabilities.
API Vitest coverage includes every `packages/domain/**/*.ts` runtime file,
including files not imported by tests; thresholds are 90% for all four metrics.
No new dependencies. No UI/native build or billing integration test is applicable.
Independent review is required before acceptance; recorded separately by reviewer.
