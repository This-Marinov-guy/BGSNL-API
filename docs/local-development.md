# Local development stack

From the sibling `BGSNL` checkout, run `npm run dev:check` to inspect configuration,
then `npm run dev:all` to replace listeners on ports 6000, 8080 and 3000 and start
Domakin Mailer, this API and the website. Ctrl+C stops the stack.

See [the frontend's development guide](../../BGSNL/README.md) for prerequisites,
port replacement behavior, template setup and real-email safety notes.

The launcher overrides configuration in child environments only:

```dotenv
APP_ENV=dev
NODE_ENV=development
PORT=8080
BILLING_WORKER_ENABLED=false
BGSNL_EMAIL_PROVIDER=domakin
MAILER_API_URL=http://127.0.0.1:6000/api
```

A fresh channel-scoped `MAILER_BULGARIANSOCIETY_SECRET` is generated in memory
and shared with the mailer. It is not the mailer admin secret. The launcher also
matches the frontend's server-only `BGSNL_SERVER_KEY` to this API's
`SSR_SERVER_KEY`. Existing `.env` files are not edited.

Outside the launcher, unset `BGSNL_EMAIL_PROVIDER` (or `legacy`) preserves the
existing Mailtrap/Resend behavior. Explicit `domakin` routes the common sender
through `/api/delivery/template`, including internal and billing notifications
via the mailer's shared BGSNL notification snapshot. The selected provider
never falls back on an ambiguous failure. Template variables, including nested
`template_variables`, are preserved; callers cannot override the sender/channel.

For legacy Resend campaigns, configure `DOMAKIN_RESEND_TEMPLATE_MAP` as a JSON
object mapping Resend IDs to registered Domakin Mailer template UUIDs. Missing
maps/templates fail locally rather than using the external legacy provider.
The historical contest-materials snapshot also needs importing before that
specific flow can be tested; it is not part of the current mailer catalog.

Run `npm run test:domakin-mailer` to verify routing without sending emails.
