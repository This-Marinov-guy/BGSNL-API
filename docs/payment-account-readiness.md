# Paid checkout account readiness

Payment success and account readiness are independent. The existing receipt capability authenticates a read-only status lookup; it does not create an account or grant benefits.

For subscriptions, `accountReady` is true only after the verified Stripe session has the webhook's `bgsnlFulfilled=1` marker, a matching subscription/customer/Stripe-region account exists, its subscription has been reconciled, and its wallet token exists. Signup classification comes from the verified checkout metadata, not a browser parameter. Only boolean readiness/signup fields reach the browser; profile data and wallet tokens do not.

The webhook already sets that marker after awaited account fulfillment and reconciliation. Its existing billing leases and completion records remain responsible for retry safety. Polling never triggers fulfillment or a second checkout. The return page continues to show the paid receipt while hiding the account/login action until readiness is explicitly true. Missing fields from an older API version fail closed.

The browser polls every five seconds while visible and skips in-flight refreshes. After two minutes it continues every fifteen seconds with reassurance and support guidance. Returning to the tab triggers a check. There is no Check again button; messages and the login action transition automatically after readiness is confirmed, respecting reduced-motion preferences. Backend errors are retried automatically and never claim a declined payment. Polling stops when ready or when the component unmounts.

Developer-only previews: `/dev/payment-result?status=account-preparing` simulates readiness after eight seconds; `/dev/payment-result?status=account-ready` starts ready (append `&free=true` for a zero-amount subscription). Previews disable real polling. These are mocked UI states, not proof of an actual Stripe payment. Production never uses the preview timer to establish readiness.

Deploy the backend before the frontend, and apply the wallet-token migration to the target environment. Verify delayed webhooks, retries, account creation and login in Stripe test mode before production rollout. Automated tests cover readiness transitions, missing account/token, database errors, paid-vs-pending results, capability isolation and the existing checkout retry protections. A real end-to-end Stripe signup has not been performed for this change.
