# Back-office membership management

The member/alumni editor includes membership controls for regional board members, national board members, Admin and Super Admin. The API independently checks active staff status, regional scope and target hierarchy. Only Super Admins can edit Admin or Super Admin accounts, or manage VIP membership transfers and cancellation. Admins can edit VIP and Developer roles. Regional board members additionally cannot manage Alumni accounts, accounts outside their region or national-board accounts. National committee can edit ordinary Member profiles across regions but cannot execute membership transfer/cancellation actions. Billing holds retain administration only for Admin/Super Admin.

## Transfer request

`POST /v1/backoffice/accounts/:type/:id/transfer` accepts an empty object. The API derives the opposite account type and sends a request to the stored account email. No account or subscription changes happen when the board sends this request.

The email opens `/user?transferTo=alumni#settings` or the member equivalent. The account holder must sign in and select/confirm their new plan through the existing subscription-change flow. The URL contains no identity, authentication token or account capability. The signed-in email is displayed before checkout. Ordinary authentication, Stripe confirmation, reconciliation and account-conversion rules still apply. This is a request for owner-confirmed transfer, not a direct administrative migration.

Redis limits requests to 20 per acting account per hour and 3 per target account per day; both expire. No new tracking collection is created. Existing email-provider configuration is used.

## Cancellation

`GET /v1/backoffice/accounts/:type/:id/membership` reads Stripe state and supplies a signed 15-minute confirmation bound to the actor, target and reviewed subscription state. If the subscription cannot be found or Stripe is unavailable, cancellation remains disabled; the UI must not describe it as no subscription. Transfer requests remain independent of that Stripe read.

`POST /v1/backoffice/accounts/:type/:id/cancel-subscription` accepts only that confirmation. It rechecks authorization and ownership under the existing subscription lease and sets only `cancel_at_period_end: true`. There is no immediate cancellation, refund or new charge. Eligible paid access continues through its period; cancelling does not settle outstanding invoices or restore benefits already withheld for billing reasons. Pending/scheduled plan changes must be resolved first.

The API validates Stripe subscription/customer ownership, uses an idempotency key and reconciles the account after cancellation. If local synchronization fails after Stripe accepted cancellation, the response reports success with `syncPending: true`; normal webhook reconciliation can finish the update. Refresh and review again after an expired or changed confirmation.

## Roles and UI

Admins can assign VIP, Support and Developer; Super Admins can also assign Admin and Super Admin. National board members can assign regional board and national committee roles across regions. Regional board members can assign regional board and regional committee roles only in their own region. Other roles remain read-only for these editors. Regional committee members have no role controls. Alumni retain national structural roles, with privileged roles available to administrators. Save profile changes before executing membership actions. Pending actions disable editing and dismissal; inline confirmation is required before sending or cancelling.

Bulk role import remains limited to Support assignments by Admin and Super Admin. It retains every other role on the account.

Deploy the website and API together. Existing JWT signing secret, Stripe, Redis, email and cookie/CSRF configuration are reused; no new environment variable is required. Tests mock all billing and email mutations.
