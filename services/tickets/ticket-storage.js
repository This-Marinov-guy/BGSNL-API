import AWS from "aws-sdk";

export function guestTicketPrefix(eventId) {
  const id = String(eventId || "");
  if (!/^[a-f\d]{24}$/i.test(id)) throw new Error("Invalid event ID for ticket storage");
  return `guest_${id}_`;
}

export function ticketObjectKey(eventId, token, type = "guest") {
  guestTicketPrefix(eventId); // Validate before constructing any storage key.
  if (!/^[A-Za-z0-9_-]{22}$/.test(token || "")) throw new Error("Missing unique ticket token");
  if (!["guest", "member"].includes(type)) throw new Error("Invalid ticket type");
  return `${type}_${eventId}_${token}.webp`;
}

// No member files, legacy names or other event prefixes are ever selected.
export async function deleteEventGuestTickets(eventId, { bucket = process.env.BUCKET_GUEST_TICKETS,
  s3 = new AWS.S3({ accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY }) } = {}) {
  const Prefix = guestTicketPrefix(eventId);
  if (!bucket) throw new Error("Missing guest ticket bucket");
  const versioning = await s3.getBucketVersioning({ Bucket: bucket }).promise();
  const versioned = ["Enabled", "Suspended"].includes(versioning.Status);
  let cursor = {}, removed = 0;
  let more = true;
  while (more) {
    const page = await (versioned ? s3.listObjectVersions({ Bucket: bucket, Prefix, MaxKeys: 1000, ...cursor })
      : s3.listObjectsV2({ Bucket: bucket, Prefix, MaxKeys: 1000, ...cursor })).promise();
    const entries = versioned ? [...(page.Versions || []), ...(page.DeleteMarkers || [])] : page.Contents || [];
    const objects = entries.filter(item => item.Key?.startsWith(Prefix)).map(item => ({ Key: item.Key,
      ...(versioned ? { VersionId: item.VersionId } : {}) }));
    for (let offset = 0; offset < objects.length; offset += 1000) {
      const batch = objects.slice(offset, offset + 1000);
      const result = await s3.deleteObjects({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }).promise();
      if (result.Errors?.length) throw new Error("Some guest ticket objects could not be deleted");
      removed += batch.length;
    }
    more = Boolean(page.IsTruncated);
    if (!more) break;
    cursor = versioned ? { KeyMarker: page.NextKeyMarker, VersionIdMarker: page.NextVersionIdMarker }
      : { ContinuationToken: page.NextContinuationToken };
    if (versioned ? !cursor.KeyMarker : !cursor.ContinuationToken) throw new Error("Missing ticket storage pagination cursor");
  }
  return removed;
}
