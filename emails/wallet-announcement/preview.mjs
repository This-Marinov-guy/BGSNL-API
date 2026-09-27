import { mkdir, writeFile } from "node:fs/promises";
import { renderWalletAnnouncement, variants } from "./render.js";

// Generate local review artifacts only; there is deliberately no mail client.
const directory = new URL("./previews/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const variant of variants) {
  const mail = renderWalletAnnouncement({ variant, name: "Alex",
    senderAddress: "PREVIEW — insert the BGSNL postal address before sending",
    unsubscribeUrl: "https://example.invalid/unsubscribe-preview-only" });
  await writeFile(new URL(`${variant}.html`, directory), mail.html);
  await writeFile(new URL(`${variant}.txt`, directory), `Subject: ${mail.subject}\nPreheader: ${mail.preheader}\n\n${mail.text}\n`);
}
console.log("Created three local wallet announcement previews. Nothing was sent.");
