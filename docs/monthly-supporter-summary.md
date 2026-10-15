# Monthly alumni supporter summary

The API sends this email at **23:59 on the last day of each calendar month** in
`Europe/Amsterdam`. It covers month start through the send cutoff. The worker
runs only in the designated email scheduler process and schedules the next
future month on startup; missed months are not backfilled.

The audience is calculated when the job runs: active tier 1–4 alumni with current
paid coverage and email notification consent, plus configured internal
notification subscribers. Addresses are normalized and deduplicated. The email
contains a thank-you, a two-column poster grid of the month's visible events,
the total number of non-refunded tickets booked for those events (including free
registrations), and counts of
new members and alumni when either count is positive. Posters have no repeated
title or date caption. The email also lists articles published that month on the
society website; optional community updates appear only when supplied. It does
not include personal account details or a figures timestamp. Events, articles,
counts, and recipients are loaded live; there is no frozen monthly summary or
saved news. Article lookup failures are logged and do not stop the rest of the
summary from sending.

National staff can view a live preview at `/user/dashboard/monthly-summary`.
`GET /dashboard/monthly-summary/:month` returns the preview and aggregate
recipient counts, never recipient addresses. Refreshing recalculates the data.
The page does not edit or save the email, and there is no manual-send route.

Each send goes through the dedicated Bulgarian Society campaign template in
Domakin Mailer. That route uses Emailit, adds a personal unsubscribe button and
one-click unsubscribe headers, and checks the Mailer's unsubscribed table before
sending. The Mailer's Google Sheet (`email_history` and `email_errors`) records
accepted sends or errors. The BGSNL database holds no `monthlySummaries` or
recipient delivery records. The month has one campaign batch ID and each address
has a deterministic operation ID, so the Mailer recognizes a repeated handoff.
The API does not retry a failed monthly send automatically; inspect the Mailer
sheet for the outcome.

```dotenv
# Defaults true only in production; local development does not send.
MONTHLY_SUPPORTER_SUMMARY_ENABLED=true
INTERNAL_NOTIFICATIONS_ENABLED=true
INTERNAL_NOTIFICATION_SUBSCRIBERS=notifications@bulgariansociety.nl
```

Do not enable the worker in development unless real recipient delivery is
intended. Tests inject the sender and never send real emails.
