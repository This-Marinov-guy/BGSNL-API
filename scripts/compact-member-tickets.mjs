// Read-only by default. --apply replaces only images larger than 1 MB.
// Original bytes, metadata and ACLs are backed up under ignored .local/.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import dotenv from "dotenv";
import AWS from "aws-sdk";
import sharp from "sharp";
import { encodeTicketImage } from "../services/tickets/ticket-image.js";

const apply = process.argv.includes("--apply");
const env = dotenv.parse(await fs.readFile(".env"));
const bucket = env.BUCKET_MEMBER_TICKETS;
if (bucket !== "bgsg-member-tickets") throw new Error("Unexpected member bucket; review the target before running");
const s3 = new AWS.S3({ region: "eu-central-1", accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY, httpOptions: { timeout: 30000 }, maxRetries: 2 });
const require = createRequire(path.resolve("../BGSNL/package.json"));
const { RGBLuminanceSource, BinaryBitmap, HybridBinarizer, QRCodeReader } = require("@zxing/library");
async function qrValue(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Int32Array(info.width * info.height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (data[i * info.channels] << 16) |
    (data[i * info.channels + 1] << 8) | data[i * info.channels + 2];
  try { return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(
    new RGBLuminanceSource(pixels, info.width, info.height)))).getText(); } catch { return null; }
}
const objects = [];
let cursor;
do {
  const page = await s3.listObjectsV2({ Bucket: bucket, ContinuationToken: cursor }).promise();
  objects.push(...(page.Contents || []).filter(item => item.Size > 1000000));
  cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (cursor);
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: objects.length }));
const backupDir = path.resolve(".local", `member-ticket-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
if (apply) await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
const report = { bucket, backupDir: apply ? backupDir : null, updated: 0, skipped: 0, qrVerified: 0, before: 0, after: 0, records: [] };
const fields = ["CacheControl", "ContentDisposition", "ContentLanguage", "Expires", "Metadata", "StorageClass", "ServerSideEncryption", "SSEKMSKeyId", "BucketKeyEnabled"];
for (const object of objects) {
  const params = { Bucket: bucket, Key: object.Key };
  const original = await s3.getObject(params).promise();
  const meta = await sharp(original.Body).metadata();
  const output = await encodeTicketImage(sharp(original.Body));
  const result = await sharp(output).metadata();
  // This maintenance run never changes ticket dimensions or uploads a larger file.
  if (result.format !== "webp" || result.width !== meta.width || result.height !== meta.height ||
      output.length >= original.Body.length || output.length > 1000000) { report.skipped++; continue; }
  const originalQr = await qrValue(original.Body);
  if (originalQr && await qrValue(output) !== originalQr) throw new Error("QR verification failed; no replacement uploaded");
  if (originalQr) report.qrVerified++;
  const id = createHash("sha256").update(object.Key).digest("hex");
  const retained = Object.fromEntries(fields.filter(field => original[field] !== undefined).map(field => [field, original[field]]));
  if (apply) {
    const acl = await s3.getObjectAcl(params).promise();
    const grants = {};
    const grantFields = { READ: "GrantRead", WRITE: "GrantWrite", READ_ACP: "GrantReadACP", WRITE_ACP: "GrantWriteACP", FULL_CONTROL: "GrantFullControl" };
    for (const grant of acl.Grants || []) {
      const grantee = grant.Grantee;
      const value = grantee.Type === "Group" ? `uri="${grantee.URI}"` : grantee.Type === "CanonicalUser" ? `id="${grantee.ID}"` : `emailAddress="${grantee.EmailAddress}"`;
      const field = grantFields[grant.Permission];
      if (!field) throw new Error("Unsupported ACL grant");
      grants[field] = grants[field] ? `${grants[field]}, ${value}` : value;
    }
    await fs.writeFile(path.join(backupDir, `${id}.original`), original.Body, { mode: 0o600, flag: "wx" });
    await fs.writeFile(path.join(backupDir, `${id}.json`), JSON.stringify({ key: object.Key, etag: original.ETag,
      versionId: original.VersionId, contentType: original.ContentType, contentEncoding: original.ContentEncoding,
      retained, grants, acl }, null, 2), { mode: 0o600, flag: "wx" });
    const current = await s3.headObject(params).promise();
    if (current.ETag !== original.ETag) throw new Error("Object changed during processing; stopped");
    const tags = await s3.getObjectTagging(params).promise();
    const Tagging = new URLSearchParams((tags.TagSet || []).map(tag => [tag.Key, tag.Value])).toString();
    await s3.putObject({ ...params, ...retained, ...grants, ...(Tagging ? { Tagging } : {}),
      Body: output, ContentType: "image/webp", ContentMD5: createHash("md5").update(output).digest("base64") }).promise();
    const saved = await s3.getObject(params).promise();
    if (!saved.Body.equals(output) || saved.ContentType !== "image/webp") {
      await s3.putObject({ ...params, ...retained, ...grants, ...(Tagging ? { Tagging } : {}), Body: original.Body,
        ContentType: original.ContentType, ContentEncoding: original.ContentEncoding }).promise();
      throw new Error("Replacement verification failed; original restored");
    }
  }
  report.updated++;
  report.before += original.Body.length;
  report.after += output.length;
  report.records.push({ id, before: original.Body.length, after: output.length, format: meta.format, qrVerified: Boolean(originalQr) });
  if (apply) await fs.writeFile(path.join(backupDir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  if (report.updated % 10 === 0) console.log(JSON.stringify({ processed: report.updated, qrVerified: report.qrVerified }));
}
const { records, ...summary } = report;
console.log(JSON.stringify(summary));
