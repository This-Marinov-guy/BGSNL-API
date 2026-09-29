# Automatic member and alumni cards

New MemberUser and AlumniUser saves provision a random 128-bit token in `walletCards` before the account save completes. The token remains outside account/session responses. Public lookups still require an eligible account and resolve current profile/status data. Authenticated wallet reads do not create records. If a card is missing, Settings shows Create instead of Open, Share and Add to Wallet; the authenticated POST repairs it and refreshes availability.

Automatic provisioning does not populate consent fields. Historical opt-in records are preserved. Cards are accessible to anyone with their unguessable link; creating them automatically is now the intended product behavior. Previously revoked records are never automatically reactivated. The backend revoke/restore endpoints remain available, but the Settings banner now only has Open, Share and the supported wallet button.

## Backfill existing accounts

Applied to the verified development cluster (`test` database) on 2026-09-22: 543 account records scanned, 435 wallet records added, 436 wallet records total. The final scan found all 543 accounts covered with zero missing tokens. Member/alumni identities may share a wallet record. Existing token/revocation values were preserved and token uniqueness was verified. That run changed development only.

Applied to production on 2026-09-28 using the running `bgsnl-api` container's database configuration, verified against the production target and distinct from development. Both clusters use a database named `test`; the database name alone does not identify the environment. The dry-run scanned 543 accounts and found 541 without coverage. Apply created 435 wallet records because member/alumni counterparts can share a card. Final verification found 543 accounts covered, zero missing, 436 total wallet records, zero invalid tokens, and unchanged pre-existing card ownership, token and revocation values. The unique token index was verified before inserting. No API restart or deployment was required.

The pre-backfill wallet documents and indexes are stored on the VPS at `/root/bgsnl-backups/wallet-cards-before-20260928.json` with mode `0600`. This backup contains private card tokens; do not commit or publish it. Production's MemberUser and AlumniUser models already have the automatic provisioning plugin enabled, and signup/payment creation paths use their save hooks. Wallet provisioning, card behavior and account-readiness tests passed (12 tests).

For another run, take a database backup and choose the target explicitly. Configure `WALLET_MIGRATION_MONGODB_URI` and `WALLET_MIGRATION_DB_NAME` securely in your shell or an ignored environment file; never commit them.

```sh
node --env-file=.env.wallet-migration scripts/backfill-wallet-cards.js --dry-run
node --env-file=.env.wallet-migration scripts/backfill-wallet-cards.js --apply
```

Dry-run disables automatic collection/index creation and performs reads only. Apply creates/verifies the unique token index, then scans `memberUsers` and `alumniUsers` with a cursor. Only missing records are inserted. Re-running preserves tokens, aliases and revocations; partial runs are safe to retry. Output is counts only, never names, credentials or tokens. Shared member/alumni identities reuse a record. Tokens are assigned to every account; public visibility is independently restricted by account status.

Deploy the backend and its token index before the frontend. Run the dry-run, inspect counts, then explicitly apply. Verify signup, member-to-alumni conversion, existing-account Open/Share and installation on supported devices. Query-upsert/bulkWrite imports that bypass Mongoose save/insertMany middleware must call `ensureWalletRecord` or run this backfill afterwards.

An interrupted/failed account save may leave an orphan wallet record, but it cannot reveal profile data because the associated account must exist. Revocation and existing token values must never be reset to roll this feature out.
