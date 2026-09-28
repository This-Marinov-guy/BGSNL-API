import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import QRCode from "qrcode";
import { encodeTicketImage } from "../services/tickets/ticket-image.js";

test("ticket uploads are real compact WebP, not renamed PNG files", async () => {
  const pixels = Buffer.alloc(1500 * 485 * 3);
  let seed = 12345;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const png = await sharp(pixels, { raw: { width: 1500, height: 485, channels: 3 } }).png().toBuffer();
  const encoded = await encodeTicketImage(sharp(png));
  const meta = await sharp(encoded).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 1500);
  assert.equal(meta.height, 485);
  assert.ok(encoded.length < png.length / 2);
});

test("custom tickets are bounded without stretching or enlarging", async () => {
  for (const [width, height, expectedWidth, expectedHeight] of [[3000, 1000, 1500, 500], [600, 200, 600, 200]]) {
    const output = await encodeTicketImage(sharp({ create: { width, height, channels: 3, background: "white" } }));
    const meta = await sharp(output).metadata();
    assert.equal(meta.width, expectedWidth);
    assert.equal(meta.height, expectedHeight);
  }
});

test("QR edges retain strong contrast after ticket encoding", async () => {
  const qr = await QRCode.toBuffer("https://bulgariansociety.nl/t/AbCdEfGhIjKlMnOpQrStUv", { width: 180, margin: 4 });
  const original = await sharp(qr).greyscale().raw().toBuffer();
  const output = await encodeTicketImage(sharp(qr));
  const decoded = await sharp(output).greyscale().raw().toBuffer();
  assert.equal(decoded.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.equal(decoded[i] < 128, original[i] < 128);
  }
});
