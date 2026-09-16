# Event promo codes

Step 3 (Upsell) stores promo configuration in `Event.product.promoCodes`; draft values stay in the existing draft data. Missing audiences on legacy codes mean all audiences. No additional database collections or redemption logs are created.

Buyers continue to enter their code inside Stripe Checkout. New codes use one event-product-restricted Stripe coupon with a shared redemption cap and expiration. Each new eligible checkout receives a fresh Stripe customer and customer-restricted promotion codes expiring with its 31-minute checkout session (or sooner if the configured expiration is earlier). These Stripe objects are not stored in our database. The API derives the audience from the authenticated, reconciled account, using the existing active-member role and benefit rules. Guest flows receive guest eligibility. Active members are a distinct audience from regular members.

Stripe tracks and enforces redemptions. The cap is per code across all audiences, rather than a separate allowance per customer. Fixed discounts use euro cents. The coupon applies only to the event product, not unrelated products or add-ons. Stripe customer and promotion objects remain in Stripe as payment records; promotion validity is time limited.

Published discount amounts, expiration, redemption limits and legacy minimum spend are immutable to avoid resetting Stripe counters. Create a new code to change these terms. Code names, audiences and active status remain editable. Editing or removing a code deactivates issued promotion codes. Previously applied discounts on an already-created payment are governed by Stripe; changes cannot retroactively undo completed or in-progress payments.

Unchanged legacy global codes retain their existing behavior. Editing a legacy code migrates it to customer scoping, carrying forward redemptions already recorded by Stripe. A conflicting active global code name is rejected. Disabling the promo panel submits an empty list to retire its codes.

Member checkout reuse includes a promo/audience signature. When these settings change, the old checkout must expire before a replacement is created. One-click email checkout goes through the same preparation.

Verification uses mocked Stripe objects only; no real tickets, payments, coupons or customer records are created by the tests. Run `node --test tests/event-promo-codes.test.js tests/member-event-announcements.test.js tests/member-ticket-policy.test.js tests/ticket-pricing.test.js tests/form-validation.test.js`.

Stripe references: https://docs.stripe.com/api/promotion_codes/create and https://docs.stripe.com/api/coupons/create.
