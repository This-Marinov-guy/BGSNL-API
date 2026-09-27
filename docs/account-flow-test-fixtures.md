# Account-flow test fixtures

The fixture seeder creates synthetic accounts only in an isolated MongoDB database. It refuses the application's production default database and refuses any database containing non-fixture member or alumni emails.

Run a validation-only preview:

```sh
FLOW_TEST_DB_NAME=bgsnl_flow_test_local \
FLOW_TEST_PASSWORD='<at-least-12-characters>' \
node scripts/seed-account-flow-fixtures.js
```

Create or reset the fixtures:

```sh
FLOW_TEST_DB_NAME=bgsnl_flow_test_local \
FLOW_TEST_PASSWORD='<at-least-12-characters>' \
npm run seed:account-flows
```

All login accounts use the supplied `FLOW_TEST_PASSWORD`. It must also satisfy the shared password policy: uppercase, lowercase and a number, with a maximum of 72 UTF-8 bytes. The seeder retains its minimum of 12 characters.

For password/signup/webhook verification with automatic cleanup and no real Stripe/email calls, use the separate [password-flow development tests](password-hashing.md).

| Email | Type | State | Expected behavior |
| --- | --- | --- | --- |
| `member-active@flow-test.bgsnl.local` | Member | active | Legacy active benefits and member discount |
| `member-locked@flow-test.bgsnl.local` | Member | locked, expired | Login works; benefits are locked; resubscription is available |
| `member-payment-awaiting@flow-test.bgsnl.local` | Member | payment awaiting | Login works without benefits while payment is pending |
| `member-frozen@flow-test.bgsnl.local` | Member | frozen | Login works; membership change is rejected and support is required |
| `alumni-free@flow-test.bgsnl.local` | Alumni tier 0 | active | Free alumni access without paid benefits |
| `alumni-active@flow-test.bgsnl.local` | Alumni tier 2 | active | Legacy paid alumni benefits |
| `alumni-locked@flow-test.bgsnl.local` | Alumni tier 2 | locked, expired | Login works; benefits are locked; resubscription is available |
| `alumni-payment-awaiting@flow-test.bgsnl.local` | Alumni tier 2 | payment awaiting | Login works without benefits while payment is pending |
| `alumni-frozen@flow-test.bgsnl.local` | Alumni tier 2 | frozen | Login works; membership change is rejected and support is required |
| `migrated-to-alumni@flow-test.bgsnl.local` | Alumni tier 0 + archived member | migrated | Login resolves only to the current alumni account |
| `migrated-to-member@flow-test.bgsnl.local` | Locked member + archived alumni | migrated | Login resolves only to the current member account and can resubscribe |

The fixtures intentionally contain no Stripe subscription or customer IDs, so login and entitlement checks cannot call Stripe. Do not exercise checkout with the repository's current environment: its Stripe keys are live. Configure Stripe test-mode keys and matching test price IDs before testing checkout, portal, webhook, or payment-recovery flows.

To run the API against the fixture database, keep `APP_ENV=dev` and point the Mongo connection to `bgsnl_flow_test_local`. Never reuse this database name in production deployment configuration.
