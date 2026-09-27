// Pure rendering only: importing this module never sends or schedules email.
const origin = "https://bulgariansociety.nl";
const settingsUrl = `${origin}/user#settings`;
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

export const variants = ["both", "apple", "google"];
const providers = {
  apple: {
    name: "Apple Wallet", image: "/assets/wallet-cards/buttons/add-to-apple-wallet.svg",
    width: 158, height: 50,
    instruction: "On your iPhone, open account settings in Safari. Your membership card is already there. Choose Add to Apple Wallet.",
  },
  google: {
    name: "Google Wallet", image: "/assets/commercial/enUS_add_to_google_wallet_wallet-button.svg",
    width: 283, height: 50,
    instruction: "On your Android phone, open account settings in your browser. Your membership card is already there. Choose Add to Google Wallet and follow the prompts.",
  },
};

export function renderWalletAnnouncement({ variant = "both", name = "there", unsubscribeUrl, senderAddress } = {}) {
  if (!variants.includes(variant)) throw new Error("Unknown wallet announcement variant");
  const unsubscribe = new URL(unsubscribeUrl);
  if (unsubscribe.protocol !== "https:" || unsubscribe.username || unsubscribe.password) throw new Error("An HTTPS unsubscribe URL is required");
  if (typeof senderAddress !== "string" || !senderAddress.trim()) throw new Error("Sender postal address is required");
  const selected = variant === "both" ? ["apple", "google"] : [variant];
  const names = selected.map((key) => providers[key].name).join(" and ");
  const subject = `Your BGSNL membership card, now in ${names}`;
  const preheader = "Your card is ready in Settings. Open it, share it or add it to your phone’s wallet.";
  const intro = `Your BGSNL membership card can now join you in ${names}. Keep it close for your next society event or meetup.`;
  const detail = "Your personal QR code opens your digital membership card with your name, photo, region, membership type and current Active or Locked status.";
  const privacy = "Your card is created automatically with your account. Remember that anyone with your QR link can view these details, so share it thoughtfully.";
  const verification = "Scan the QR code to check current membership status. A saved wallet pass alone is not proof of active benefits.";
  const credit = selected.includes("apple") ? "Apple and iPhone are trademarks of Apple Inc., registered in the U.S. and other countries." : "";
  const sections = selected.map((key) => {
    const provider = providers[key];
    return `<tr><td style="padding:16px 24px 8px;color:#262626;">
      <h2 style="margin:0 0 10px;font-size:20px;line-height:28px;color:#406345;">Your membership card in ${provider.name}</h2>
      <p style="margin:0 0 8px;font-size:16px;line-height:25px;">${provider.instruction}</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:8px;">
        <a href="${settingsUrl}" style="display:inline-block;text-decoration:none;"><img src="${origin}${provider.image}" width="${provider.width}" height="${provider.height}" alt="Add to ${provider.name}" style="display:block;border:0;width:${provider.width}px;height:${provider.height}px;" /></a>
      </td></tr></table>
      <p style="margin:4px 0 0;font-size:13px;line-height:20px;color:#595959;">Opens BGSNL Settings. Sign in to open or share your card; adding it to your wallet is a separate step.</p>
    </td></tr>`;
  }).join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f5f2;font-family:Arial,Helvetica,sans-serif;color:#262626;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f2;"><tr><td align="center" style="padding:24px 8px;">
<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;">
<tr><td style="padding:28px 24px;background:#d5e2d7;">
  <p style="margin:0 0 24px;font-size:18px;font-weight:bold;color:#406345;">Bulgarian Society Netherlands</p>
  <h1 style="margin:0;font-size:32px;line-height:38px;color:#28432d;">Your community.<br />Your card. With you.</h1>
</td></tr>
<tr><td style="padding:24px 24px 8px;font-size:16px;line-height:25px;">
  <p style="margin:0 0 16px;">Hi ${escape(name)},</p>
  <p style="margin:0 0 16px;">${intro}</p>
  <p style="margin:0;">${detail}</p>
</td></tr>
${sections}
<tr><td style="padding:20px 24px;font-size:14px;line-height:22px;">
  <p style="margin:0 0 12px;">${privacy}</p>
  <p style="margin:0 0 12px;">${verification}</p>
  <p style="margin:0 0 12px;">Use Open or Share in Settings, or choose the wallet button. The available wallet button depends on your device and account eligibility.</p>
  <p style="margin:0 0 16px;">Can’t see the images? <a href="${settingsUrl}" style="color:#406345;text-decoration:underline;">Open membership card settings</a>.</p>
  <p style="margin:0;">See you soon,<br />The BGSNL team</p>
</td></tr>
<tr><td style="padding:24px;background:#f2f5f2;font-size:12px;line-height:19px;color:#595959;">
  <p style="margin:0 0 8px;">Bulgarian Society Netherlands · ${escape(senderAddress)}</p>
  <p style="margin:0 0 8px;">You’re receiving this announcement because you subscribed to BGSNL updates. <a href="${escape(unsubscribe.href)}" style="color:#406345;text-decoration:underline;">Unsubscribe from announcements</a>.</p>
  ${credit ? `<p style="margin:0;">${credit}</p>` : ""}
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
  const text = [`Hi ${name},`, intro, detail,
    ...selected.map((key) => `${providers[key].name}\n${providers[key].instruction}\nOpen BGSNL Settings: ${settingsUrl}`),
    "Sign in first. Adding the card to your wallet is a separate step. Available buttons depend on your device and account eligibility.",
    privacy, verification, "See you soon,\nThe BGSNL team", `Bulgarian Society Netherlands · ${senderAddress}`,
    `You subscribed to BGSNL updates. Unsubscribe from announcements: ${unsubscribe.href}`, credit,
  ].filter(Boolean).join("\n\n");
  return { subject, preheader, html, text };
}
