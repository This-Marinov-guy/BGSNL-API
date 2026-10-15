# Regional statistics averages

The dashboard calculates averages for the selected Amsterdam-calendar date range and the authenticated region scope. The **National** selection pools all regions; it does not average the region averages. A chosen event changes the event charts and totals, while the regional averages continue to cover all published events in the selected period, including events awaiting archival.
The event metrics response includes issued ticket counts (with member and guest counts), estimated net revenue, recorded or estimated refunds, and event counts for the selected events. Regional event averages include a National benchmark calculated from all published events in the same date range. The National selection reuses its own averages as the benchmark.
Every source record belongs to exactly one displayed scope. Legacy `breda` and `bread` records count under Breda–Tilburg; missing or unknown regions count under **Unassigned**. National includes all of those scopes. Additive counts match their regional sums; averages are calculated from the pooled source records before rounding.

The `statistics` collection also stores `event-averages` and `member-averages` documents for each academic year and region, plus one document with `region: "national"`. These documents are rebuilt from source records, so retrying a job never counts an event twice. Archiving an event refreshes its academic year's event documents. The Sunday membership report refreshes the current academic year's member documents before sending email.
The API seeds missing records for the current academic year on startup and again at 00:00 Amsterdam time on 25 August. Seed writes use `$setOnInsert`, so a restart preserves figures already calculated for that period. The new year has separate regional and National records; prior-year records remain unchanged. A failed seed retries in one hour. Event seeds count only archived events held by the seed time. Each academic year runs from 25 August inclusive to the next 25 August exclusive.
Migration 018 creates the uniqueness index, backfills archived-event averages for every academic year represented in the event collection, and seeds the current academic year's member averages. It also creates empty current-year event averages when there are no archived events yet.
Migration 019 adds `calculationType` to existing statistics documents. Allowed values are `monthly`, `on-demand`, `weekly`, and `yearly`. Event averages and the legacy event/member/alumni counters are updated on demand; member averages are refreshed weekly. Monthly and yearly are available for future scheduled calculations.
Migration 020 normalizes legacy Breda source regions, rebuilds the regional and National averages, and removes the obsolete Breda statistics rows.
Migration 021 updates the stored event ticket ratio to the member percentage of all issued tickets.

| Field | Definition |
| --- | --- |
| `averageActiveMembersMonth` | Mean month-end count of current member accounts with active status and unexpired membership. The current month uses the latest available day. |
| `averageNewMembersMonth` | New current member accounts by join date, divided by the number of touched calendar months. |
| `averageEventPresence` | Mean hours from event creation to its effective date (`correctedDate` when present). Invalid or negative intervals are omitted. |
| `averageEventTicketCount` | Issued tickets, including subsequently refunded tickets, per event. |
| `averageEventTicketTypeRatio` | Pooled member, active-member, and alumni tickets as a percentage of all issued tickets. `null` means there are no tickets. |
| `averageEventRevenue` | Mean estimated net ticket and add-on revenue per event, using the event's listed prices less recorded refunds. |
| `averageEventRefund` | Mean recorded refunds per event. Older refunded rows without an amount use their listed ticket price as an estimate. |

Cancelled and draft events are excluded from dashboard event averages. The stored event averages still include archived events only and update when events are archived. Historical active member counts use the account's current join and expiry dates; a past renewal gap cannot be reconstructed from those fields. The live dashboard uses the selected date range, while the stored documents use academic years beginning on 25 August.
