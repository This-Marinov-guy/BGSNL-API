import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supportImageFilter } from "../middleware/support-image-upload.js";
import { uploadSupportImages } from "../services/support/attachments.js";
import { supportAttachments } from "../services/support/policy.js";
import SupportConversation from "../models/SupportConversation.js";

test("support uploads allow documents and images but reject executable and HTML files", () => {
  for (const mimetype of ["application/pdf", "text/plain", "image/png"]) {
    supportImageFilter({}, { mimetype }, (error, accepted) => { assert.ifError(error); assert.equal(accepted, true); });
  }
  for (const mimetype of ["text/html", "application/javascript", "image/svg+xml", "application/octet-stream"]) {
    supportImageFilter({}, { mimetype }, error => assert.ok(error));
  }
});

test("PDF and text uploads use stable raw URLs and preserve names through the schema", async () => {
  const files = [
    { buffer: Buffer.from("%PDF-1.7 mock"), mimetype: "application/pdf", originalname: "Details.pdf" },
    { buffer: Buffer.from("Example"), mimetype: "text/plain", originalname: "Steps.txt" },
  ];
  const options = { conversationId: randomUUID(), messageId: randomUUID(), upload: async (_file, config) => {
    assert.equal(config.resource_type, "raw");
    assert.equal(config.transformation, undefined);
    return `https://res.cloudinary.com/bgsnl/raw/upload/v123/${config.folder}/${config.public_id}`;
  } };
  const attachments = await uploadSupportImages(files, options);
  assert.deepEqual(attachments, await uploadSupportImages(files, options));
  assert.deepEqual(supportAttachments(attachments), attachments);
  assert.equal(attachments[0].name, "Details.pdf");
  assert.equal(attachments[0].url.includes("/v123/"), false);
  const record = new SupportConversation({ messages: [{ id: randomUUID(), author: "requester", text: "", attachments, createdAt: new Date() }] });
  assert.equal(record.messages[0].attachments[0].name, "Details.pdf");
  assert.equal(record.messages[0].validateSync(), undefined);
  assert.throws(() => supportAttachments([{ ...attachments[0], url: "https://res.cloudinary.com/bgsnl/raw/upload/file.html" }]));
  assert.throws(() => supportAttachments([{ ...attachments[0], name: "x".repeat(201) }]));
});
