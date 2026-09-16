# Account roles and access

Role names and assignments updated on 16 September 2026. This describes the implemented policy, including existing exceptions that still need a decision.

## Assignment in member administration

Only Super Admins can edit accounts carrying Admin, Super Admin or VIP roles. This also covers transfer requests and subscription cancellation, for both member and Alumni accounts. The API uses the stored target roles, not submitted roles.

- Member accounts: active member, regional board/committee, national board/committee and support.
- Alumni accounts: **national_board_member** and **national_committee_member** only.
- VIP, Admin and Super Admin cannot be added, removed or changed through this panel. Existing assignments are preserved server-side and displayed read-only.
- The base member/alumni role is determined by the account collection, never the submitted role list.
- The API enforces the allowed assignments, not just the checkboxes. Saving an Alumni account replaces non-protected editable assignments with the submitted national roles; existing regional/support/active-member assignments are removed on that save.
- Users cannot change their own roles or status. Actual access changes increment sessionVersion to revoke existing sessions. Merely renaming a role does not revoke sessions.

## Administration pages

| Role | Events | Member/Alumni management | Internships | Support inbox |
| --- | --- | --- | --- | --- |
| super_admin | All regions | All regions | Yes | Yes |
| admin | All regions | All regions | Yes | Yes |
| national_board_member | All regions | All regions | Yes | No |
| national_committee_member | All regions | Members only, all regions | No | No |
| regional_board_member | Regional listing and sales controls | Members only, own region | No | No |
| regional_committee_member | Regional listing and sales controls | No | No | No |
| active_member | Regional listing and sales controls | No | No | No |
| support | No | No | No | Yes |
| vip | No | No | No | No |
| member | No | No | No | No |
| alumni | No | No | No | No |

Permissions combine when an account has multiple roles. All signed-in accounts retain their usual personal account, tickets and support-request functions, subject to account status and subscription benefits. The administration landing page also permits access requests.

National committee members can manage all events and Member accounts, across regions. Alumni administration remains limited to national board and Admin/Super Admin. National committee does not gain internships, support, transfer or cancellation permissions. Admin, Super Admin and VIP targets remain editable only by Super Admin.

## Other current permissions

- National board, Admin and Super Admin can export member statistics and invoke member/Alumni conversion endpoints.
- National board, national committee, regional board, Admin and Super Admin can use manual ticket creation, guest check-in, event calendar sync and the existing non-society-event reminder endpoints (EVENT_MANAGEMENT_ACCESS).
- National board, national committee, regional board, regional committee, Admin and Super Admin pass the member/event analytics API gates. Regional API queries restrict results to the account region. Active members do not pass those API gates.
- Analytics panels currently show Coming soon to everyone except Admin and Super Admin via the website ANALYTICS_COMING_SOON flag. This is a UI gate, not an additional API authorization rule. The event analytics tab uses EVENT_MANAGEMENT_ACCESS; regional committee accounts do not see it.
- Active-member ticket pricing applies to eligible paid member accounts with ACCESS_4 roles: active member, either regional role, national board, national committee, Admin or Super Admin. An Alumni role does not grant the member programme discount.
- VIP has no administration access. Its membership expiry date is ignored and responses expose nonExpiring: true. Account status and Alumni tier restrictions still apply. If a subscription exists, fresh Stripe verification and payment eligibility remain required; VIP does not bypass billing holds, cancel billing or grant a paid Alumni tier.
- Admin and Super Admin can use administration during billing-only locked/payment_awaiting states. Frozen/suspended status blocks administration for everyone. Other staff roles require active status.
- No additional Super Admin-only page was found in the current routes. The role is separately defined and protected from removing/deactivating the last active Super Admin.

## Existing permission gaps to review

These were found while tracing the current behavior; role renaming preserves them rather than claiming they are fixed:

1. Regional event listings and sales toggles enforce the user's region, but the older general event read/edit/delete checks only exclude Netherlands events. Draft ownership can also allow access outside the current region. Regional-only event access is therefore not uniformly enforced across API operations.
2. Manual ticket/check-in/reminder/calendar endpoints use EVENT_MANAGEMENT_ACCESS but do not consistently enforce an event-region boundary in their controllers.
3. Regional board users can currently submit all editable member role assignments in their region, including national board and support. The panel/API lacks an actor-specific assignment hierarchy. This is an existing escalation path and needs a separate policy decision and restriction.
4. Subscription account conversions preserve administrative assignments. Existing/migrated Alumni records are not automatically stripped of old regional roles until saved through this panel. This change restricts panel assignments; it is not a bulk database cleanup or conversion-policy change.

## Compatibility and rollout

| Previous value | Canonical value |
| --- | --- |
| society_board_member | national_board_member |
| board_member | regional_board_member |
| committee_member | regional_committee_member |

Old values continue to pass the same access checks so existing accounts and sessions remain usable. Back-office responses display canonical names; saving writes the canonical values. No database-wide role migration has been run. Deploy website and API together because new assignments use the new role identifiers. National committee has explicit event and member groups, while ACCESS_2 (internships) and ACCESS_3 (board-only membership actions) retain their existing scope.

Implementation: API util/config/defines.js and util/config/account-roles.js; website src/util/defines/common.js, src/util/account-roles.mjs and src/util/administration.mjs. API services/backoffice/accounts.js enforces assignments.

## Membership management panel

Regional board (Member accounts in own region only), national board, Admin and Super Admin can request an account-type transfer and cancel renewal. Committee/support roles cannot use these actions. VIP is no longer assignable; existing VIP assignments remain read-only. See [Membership management](backoffice-membership.md) for billing behavior and validation.
