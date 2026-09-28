# Event ticket storage and archive cleanup

Every newly issued ticket receives a 128-bit random, case-sensitive token, even when the event does not print a QR code. A multi-admission purchase retains one shared ticket/token; its guest-list rows share that token.

Object names are `guest_{eventId}_{ticketToken}.webp` or `member_{eventId}_{ticketToken}.webp`. Existing bucket assignments are unchanged. Generated tickets and manually uploaded member ticket images use the same naming rule.

Both upload paths encode actual WebP at quality 85 (alpha quality 100, effort 6), rather than lossless WebP or a renamed PNG. Generated tickets keep their 1500 × 485 layout. Custom uploads preserve aspect ratio, are bounded to 1500 × 1500 and are never enlarged. File size depends on image complexity; there is no guaranteed byte cap. Existing bucket objects are not recompressed automatically.

## Existing oversized member tickets

Run `node scripts/compact-member-tickets.mjs` from the API directory for a read-only comparison. `--apply` replaces member images larger than 1,000,000 bytes in the explicitly guarded production member bucket. It reads credentials from `.env` without logging them and uses the existing sibling frontend's ZXing dependency for QR verification.

The maintenance script backs up original bytes, metadata and ACLs to ignored `.local/member-ticket-backup-*` directories with restricted permissions. Object keys/URLs, dimensions, tags and access grants are preserved. It skips images that would change dimensions, exceed the threshold or grow in size, and aborts if a QR decoded in the original cannot be decoded identically in the replacement. Images without a decodable original QR are not counted as QR-verified. Every upload is downloaded again for exact byte verification. Existing small tickets are not touched. Keep the backup directory until the replacements have been accepted; original image bytes and headers can be restored to the recorded keys if needed.

Manual event archiving and the expired-event scheduler share `services/events/archive-event.js`. They close sales and record statistics transactionally, then perform the existing spreadsheet, Stripe and media cleanup plus guest-ticket cleanup. Only objects beginning with the exact `guest_{eventId}_` prefix in `BUCKET_GUEST_TICKETS` are selected. Member ticket images and guest-list records remain.

Guest-file deletion is permanent: when S3 versioning is enabled or suspended, all matching versions and delete markers are removed. Listing is paginated and partial deletion failures throw. The deployment credentials need `s3:GetBucketVersioning`, `s3:ListBucket`, `s3:ListBucketVersions`, `s3:DeleteObject` and `s3:DeleteObjectVersion` on the appropriate bucket/resources. These permissions must be verified before deployment.

`archiveCleanupPending` is saved before external cleanup. Failed guest-file deletion leaves this flag set, and the next scheduled run retries archived events with pending cleanup without counting statistics again. Successful cleanup sets `archiveCleanupCompletedAt`. Existing Stripe/Cloudinary helpers retain their own error handling.

Existing legacy filenames are not renamed or selected by this cleanup. Existing tickets are not backfilled by this change. Previously archived events are not swept automatically unless they have pending cleanup. Deploying this change enables irreversible guest-file cleanup on subsequent manual/scheduled archiving; local tests use mocked storage and do not delete live files.
