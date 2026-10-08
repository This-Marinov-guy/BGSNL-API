# Existing Member regional Connect migration plan

Date: 2026-09-29  
Status: Boundary-aware code deployed and five-subscription production pilot applied on 2026-10-08. The wider eligible cohort remains pending pilot renewal reconciliation.

## Objective

Enrol existing Members, not Alumni, in regional revenue sharing for regions with an active, eligible Connect account. Preserve the customer ID, billing cycle, payment details, subscription settings and account history.

For centrally billed Members, retain the existing subscription ID as well. Recreating subscriptions is unnecessary for the recommended approach.

## Recommended architecture

Keep customers, subscriptions, payment methods and invoices on the main Netherlands Stripe account. Route the regional share of eligible payments to the region through separate Connect transfers, using the existing revenue-sharing architecture.

This connects the subscription to a regional revenue allocation. It does **not** move ownership of the customer or subscription to the regional Stripe account. Regional accounts receive transfers rather than hosting those subscriptions.

Existing implementation: [Regional Member subscription revenue](./member-revenue-sharing.md).

Stripe reference: [Subscriptions with Connect](https://docs.stripe.com/connect/subscriptions).

## Scope and eligibility

- Include current Member accounts only. Exclude Alumni accounts and Member records already migrated to Alumni.
- Verify the subscription and customer against their actual owning Stripe account; do not infer ownership from profile region.
- Automatically enrol only centrally billed, verified Member subscriptions in an eligible region.
- Leave unsupported regions unchanged.
- Skip already enrolled subscriptions with a matching allocation. Flag conflicting allocations for review rather than overwriting them.
- Report missing subscriptions, duplicate billing identities, unknown prices and ambiguous account matches for review.
- Do not restart ended subscriptions or clear account restrictions as part of this migration.
- Review delinquent, paused, trialing and scheduled-change subscriptions separately before including them. Preserve their existing state and collection policy.
- Preserve scheduled cancellations and prepaid access. A subscription that ends before the sharing boundary must not be renewed just to enrol it.

### Configured regional recipients

The code currently maps these regions:

- Amsterdam
- Groningen
- Leeuwarden
- Leiden–The Hague
- Rotterdam

This list is configuration, not a guarantee of current production eligibility. Before applying each batch, verify the recipient belongs to the main platform, its `transfers` capability is active, and payouts are enabled. Recheck eligibility before settlement too.

## Data that must remain unchanged

For the in-place central-account migration, preserve:

- Customer and subscription IDs, and the owning Stripe account.
- Prices, currency, quantities, payment interval and billing-cycle anchor.
- Current billing-period dates and next scheduled payment date.
- Payment methods, mandates and collection method.
- Discounts, tax settings, customer balances and credits.
- Cancellation settings, trials, pauses, pending updates and subscription schedules.
- Historical invoices, payments, refunds, disputes and payment-retry state.
- Profile data, account restrictions and benefit eligibility.
- Existing billing portal and Member/Alumni switching behavior.

The migration must not create an invoice, collect funds, reset billing dates, send a new-subscription email or require another checkout. Normal scheduled billing continues independently.

## Phase 1 — Read-only inventory and dry run

1. Read Member records and resolve each subscription in its actual Stripe account.
2. Cross-check account identity, customer ownership and the current Member plan.
3. Capture a secure baseline containing IDs, profile region, proposed recipient, billing dates, amounts, status, cancellation settings and pending changes.
4. Verify regional recipients live.
5. Classify each record as eligible, already enrolled, unsupported region, legacy regional billing, or manual review, with a reason.
6. Produce counts by region and classification, plus a per-subscription proposed change report.

Do not write to Stripe or the database during this phase. Protect reports containing personal or billing data; do not commit them to Git.

## Phase 2 — Implement a prospective allocation boundary

**Do not simply attach the existing allocation metadata to old subscriptions.** The current worker scans all paid invoices on enrolled subscriptions. Without a boundary, enrolment could trigger transfers for historical payments.

Recommended policy: sharing begins with each Member's next billing period after enrolment, with no retrospective transfers.

Implementation requirements:

- Add a versioned migration allocation with a stable operation ID and explicit eligibility boundary.
- Determine eligibility from the billed service period and invoice lineage, not only the invoice payment timestamp. An old overdue invoice paid after migration must remain excluded.
- Handle prorations and credits that cross the boundary explicitly. Send ambiguous cases to review instead of transferring automatically.
- Apply refunds, disputes and credit adjustments only against the appropriate eligible allocations; do not recover a regional share that was never transferred.
- Preserve existing enrolled subscriptions' behavior through compatible metadata parsing and validation.
- Ensure subscription schedules and later updates do not erase or silently replace the allocation.
- Support pausing the migrated cohort without unnecessarily pausing all existing regional sharing.

Document and test the precise boundary rules before enrolling any live subscriptions.

## Phase 3 — Build the migration runner

1. Default to dry-run mode. Require an explicit apply option and approved input manifest for mutations.
2. Save a secure backup of relevant subscription metadata and database fields before each change.
3. Use the existing billing leases and re-read Stripe state immediately before mutation. Skip records changed since the approved baseline.
4. Add allocation metadata to the existing subscription without changing billing fields or replacing unrelated metadata.
5. Reconcile `subscription.connected` from the verified allocation; setting the flag alone does not enrol a subscription.
6. Record completed and skipped operations in a resumable audit manifest.
7. Verify the preservation invariants after every write.

Stripe and database writes are not one atomic transaction. If metadata succeeds but database reconciliation fails, a retry must reconcile the existing allocation rather than create another one. Reruns must not duplicate enrolment or transfers.

Retain the current fee allocation unless separately approved:

```text
central share = round(collected amount × 20%)
regional transfer = collected amount − central share − actual processing fees
```

Use the existing refund, dispute and fee reconciliation rules for eligible payments.

## Phase 4 — Test in an isolated environment

Cover at least:

- Monthly and annual renewals, including unusual billing dates.
- Discounts, credits and scheduled plan changes.
- Failed payments and successful recovery without changing retry rules.
- Old unpaid invoices paid after the sharing boundary: no historical transfer.
- Cancellations, including cancellation scheduled before the next billing period.
- Member-to-Alumni and Alumni-to-Member changes under the documented allocation rules.
- Refunds, disputes and prorations before, after and across the boundary.
- Duplicate and out-of-order webhooks, worker retries and process interruption.
- Migration reruns and Stripe-success/database-failure recovery.
- Recipient deactivation between enrolment and settlement.
- Existing enrolled subscriptions remaining unaffected.

Acceptance criteria:

- All preservation invariants match before and after migration.
- No migration-triggered charge, invoice, checkout or new-subscription email.
- No historical invoice receives a new regional allocation.
- Only eligible Member payments generate transfers, exactly once in net settlement.
- Alumni and unsupported regions remain unchanged.
- Existing benefits, billing management and account-lock policies still work.

## Phase 5 — Production rollout

1. Obtain explicit approval for the recipient list, eligibility report, allocation policy and apply batch.
2. Deploy and verify boundary-aware code in every API and worker process before adding migration allocations. Prevent older workers from processing new allocations.
3. Begin with a small approved pilot in each eligible region, avoiding imminent renewals where practical.
4. Compare Stripe and database state against the baseline immediately after enrolment.
5. Monitor the pilot's first eligible payments, fees, transfers and reconciliation results before expanding.
6. Continue in small resumable batches, stopping on unexpected billing changes or accounting discrepancies.

Do not treat `subscription.connected = true` as proof of a completed transfer or bank payout.

### Prepared runner and boundary policy

`scripts/migrate-existing-member-connect.js` defaults to a read-only live
inventory. It checks the central Stripe account and all five recipients, reads
Member and Alumni identities, verifies candidate subscriptions and customers,
and writes a private manifest only when given `--output`. It excludes noncurrent
Members, unsupported regions, legacy regional billing, existing allocations,
nonactive or scheduled subscriptions, plan mismatches, duplicate identities,
and renewals within 24 hours. A pilot manifest contains one eligible Member per
region whose next renewal is at least seven days away where available.

The migration allocation is version 2. It stores the current period end as
`effectivePeriodStart` and the actual enrolment time as `enrolledAt`. The worker
shares only paid Member invoices created after enrolment whose positive Member
service lines begin on or after the boundary. Old service periods are excluded
even if payment arrives late. Crossing or incomplete service periods and Member
charges using credits from a pre-boundary invoice are held for review. Version 1
Checkout allocations keep their existing behavior. Set
`MEMBER_REVENUE_MIGRATED_ENABLED=false` to pause the migrated cohort while
leaving version 1 sharing active.

Apply needs a fresh, explicitly approved manifest hash, a private exclusive
backup path, and a separate audit path. The runner rechecks the Stripe account,
recipient, subscription billing snapshot, Member document, billing lease and
period boundary before changing two Stripe metadata fields and then the MongoDB
`subscription.connected` flag. If Stripe succeeds and MongoDB fails, rerun the
same manifest with new backup/audit paths; it recognizes the exact allocation
and reconciles the flag without writing Stripe again. A manifest expires after
24 hours. Never add version 2 metadata until the API and worker release that
understands it is deployed and verified in every process; an older worker will
reject it.

Example read-only invocation on a host with production credentials:

```bash
node scripts/migrate-existing-member-connect.js --output=/private/secure/connect-inventory.json
node scripts/migrate-existing-member-connect.js --pilot --output=/private/secure/connect-pilot.json
```

After the approved release is deployed and the approved pilot manifest is
reviewed, run `--apply` with `--manifest`, `--approved-sha256`, `--backup`, and
`--audit` pointing to private files. Do not run a broad cohort until the pilot's
first eligible invoices and transfers have been reconciled.

### Production pilot record — 2026-10-08

- The pre-apply inventory found 126 eligible existing Members across the five
  regions, 7 already-enrolled active Members, 12 subscriptions needing state
  review, 2 with imminent renewals, and 30 active Members in unsupported
  regions. The remaining eligible cohort is 121 after this pilot.
- One subscription in each of Amsterdam, Groningen, Leeuwarden,
  Leiden–The Hague, and Rotterdam was enrolled. The approved manifest, exact
  subscription IDs, metadata and MongoDB backups, and per-row audit are private
  files under `/root/bgsnl-connect-migration/` on the production host; they are
  intentionally absent from Git.
- Post-apply read-only checks found five matching version 2 allocations and
  five `subscription.connected` flags. All five Stripe billing snapshots and
  unrelated metadata values matched the pre-apply baseline. No invoice was
  created and no historical regional transfer was found. All five previously
  paid invoices classify as excluded by the prospective boundary.
- The pilot's next billing periods begin from 2026-10-16 through 2026-10-28.
  Reconcile the first eligible invoices, actual fees, transfers and account
  flags before approving another batch.

## Monitoring and rollback

- Monitor failed allocation validation, postponed transfers, pending operations, duplicate settlement attempts and unrecovered regional fees.
- Pause affected migration allocations if discrepancies appear, while keeping normal subscription billing and benefits unchanged.
- Before any money movement, restore backed-up metadata and reconcile the reporting flag when safe, preserving concurrent legitimate changes.
- After transfers occur, keep allocation history and audit records intact. Removing metadata does not reverse a transfer.
- Review any transfer reversal as a separate financial correction requiring approval; do not automatically reverse funds as part of a metadata rollback.

## Separate track — Legacy regional billing

Members whose customers and subscriptions belong to older regional Stripe accounts are not automatically eligible for the central account's transfer worker.

Inventory these accounts separately. Verify whether the owning account is the intended connected recipient or a distinct legacy account. Do not change `stripeRegion` in the database to make records appear centrally owned.

If billing ownership must move across accounts, treat that as a separate migration project:

- The standard Connect recurring-payment cloning flow creates a customer on the destination account; it does not preserve the original customer object.
- Payment-method cloning has type restrictions and is not a universal mandate migration mechanism.
- Historical invoices and payment records must remain accessible in their source account.
- Subscription recreation requires explicit handling of the next billing date, cancellation of old collection, credits, outstanding invoices and prevention of double billing.
- If unchanged customer IDs are mandatory, confirm a supported account-specific migration route with Stripe before promising or implementing it. Do not assume ordinary API cloning satisfies that requirement.

Reference: [Share payment methods across accounts for direct charges](https://docs.stripe.com/connect/direct-charges-multiple-accounts).

## Decisions to confirm before implementation

1. Regional revenue allocation, rather than regional ownership of subscriptions, is the intended outcome.
2. Sharing starts with the next billing period, with no historical redistribution.
3. The existing 20% central share and processing-fee allocation remain unchanged.
4. Legacy regional subscriptions stay on a separate review track until a preservation-compatible approach is approved.

Saving this plan does not authorize production mutations, transfers, deployment or Git publishing.
