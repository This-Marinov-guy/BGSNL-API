import test from "node:test";
import assert from "node:assert/strict";
import { renderWalletAnnouncement, variants } from "../emails/wallet-announcement/render.js";

const options = { name: "Alex", senderAddress: "Example address", unsubscribeUrl: "https://example.org/unsubscribe?token=example&source=wallet" };
for (const variant of variants) {
  test(`${variant} announcement includes the correct wallets and safe setup instructions`, () => {
    const mail = renderWalletAnnouncement({ ...options, variant });
    assert.equal(mail.html.includes('alt="Add to Apple Wallet"'), variant !== "google");
    assert.equal(mail.html.includes('alt="Add to Google Wallet"'), variant !== "apple");
    assert.match(mail.html, /https:\/\/bulgariansociety.nl\/user#settings/);
    assert.match(mail.html, /&amp;source=wallet/);
    assert.match(mail.text, /anyone with your QR link/);
    assert.match(mail.text, /not proof of active benefits/);
    assert.match(mail.text, /Unsubscribe from announcements/);
    assert.doesNotMatch(mail.html, /<script|\/api\/user\/wallet|\/c\//);
    assert.equal(mail.html.includes("trademarks of Apple Inc."), variant !== "google");
  });
}
test("recipient data is escaped and required sending fields are validated", () => {
  const mail = renderWalletAnnouncement({ ...options, name: '<img src=x onerror="alert(1)">', senderAddress: "A & B" });
  assert.match(mail.html, /&lt;img/);
  assert.match(mail.html, /A &amp; B/);
  assert.doesNotMatch(mail.html, /<img src=x/);
  assert.throws(() => renderWalletAnnouncement({ ...options, variant: "unknown" }));
  assert.throws(() => renderWalletAnnouncement({ ...options, unsubscribeUrl: "javascript:alert(1)" }));
  assert.throws(() => renderWalletAnnouncement({ ...options, senderAddress: "" }));
});
