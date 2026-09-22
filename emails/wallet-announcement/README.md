# Wallet announcement emails

Three English launch drafts: `both` (default), `apple`, and `google`. The renderer returns `subject`, `preheader`, `html`, and `text`. No sending, audience selection, scheduling, or provider upload is connected.

## Preview and edit

From BGSNL-API:

```sh
node emails/wallet-announcement/preview.mjs
node --test tests/wallet-announcement.test.js
```

Open `previews/both.html`, `previews/apple.html`, or `previews/google.html`. Edit copy and inline email styles in `render.js`, then regenerate. Preview data is fictional; the preview unsubscribe URL intentionally does not work.

Templates use table layout, inline styles, system fonts, explicit image dimensions, image alt text, and plain-text alternatives. The header is BGSNL branding, not an imitation of either wallet's interface. No member photograph, public QR token, or signed pass URL is included in a broadcast.

## Branding decisions

- [Apple badge guidelines](https://developer.apple.com/wallet/add-to-apple-wallet-guidelines/): existing official English SVG, unchanged; light background; 8px clear space exceeds 0.1 × its 50px height; device instructions; applicable trademark credit. No standalone Wallet icon or decorative effects.
- [Google brand guidelines](https://developers.google.com/wallet/generic/resources/brand-guidelines): uploaded official English primary SVG, unchanged; 283 × 50px; 8px clear space; no other button is larger; full Google Wallet name.
- Badges are next to membership-card instructions. Links explicitly open Settings, not a direct download. Cards are created automatically; sign-in remains required for owner actions. No direct GET link is fabricated for the Google POST endpoint.
- SVG support varies across email clients. Text links remain available when images are blocked or unsupported. Test delivered emails in your actual target clients before approving these drafts; browser previews do not prove inbox compatibility.

## Release checklist — do not send the launch copy yet

1. Deploy and verify the public QR page, Apple installation, and Google installation; obtain Google publishing approval for the intended audience.
2. Confirm production badge URLs resolve publicly and Settings survives sign-in navigation.
3. Preview in Apple Mail, Gmail, and Outlook on mobile and desktop, including images disabled and dark mode.
4. Supply the actual sender postal address and a working recipient-specific unsubscribe URL. Send only to eligible members who opted into announcements; respect unsubscribes and suppression lists. Never infer a recipient's phone type. Use `both` unless their preference is known.
5. Import rendered HTML/text into the existing mail provider and map its escaped recipient variables and unsubscribe mechanism. Provider-hosted template IDs have not been created.
6. Review a test delivery before separately authorizing the campaign. Do not send the generated mock previews.

The wording is a launch announcement for use after readiness is confirmed, not a claim that production has already launched.
