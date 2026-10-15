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

Event and member statistics are available to every role with an administration
dashboard area, including active member, committee, support and developer.
These read-only endpoints return aggregate data without member or ticket
identities. All-region roles may filter by region; other roles are restricted
to their signed-in region and need a region assignment to view statistics.
Management pages and detailed member/event analytics retain their separate
role gates.

National committee members can manage all events and Member accounts, across regions. Alumni administration remains limited to national board and Admin/Super Admin. National committee does not gain internships, support, transfer or cancellation permissions. Admin, Super Admin and VIP targets remain editable only by Super Admin.

## Other current permissions

- National board, Admin and Super Admin can export member statistics and invoke member/Alumni conversion endpoints.
- National board, national committee, regional board, Admin and Super Admin can use manual ticket creation and guest check-in for events in their authorized region. Calendar sync and non-society-event reminders are reserved for all-region roles.
- Detailed member/event analytics API gates remain limited to management roles. Regional queries use the signed token's region; a requested region cannot widen it. The separate statistics endpoints serve dashboard roles with aggregate-only responses.
- The website ANALYTICS_COMING_SOON flag is disabled. Management analytics tabs remain role-gated, while the dedicated statistics pages are available to dashboard roles.
- Active-member ticket pricing applies to eligible paid member accounts with ACCESS_4 roles: active member, either regional role, national board, national committee, Admin or Super Admin. An Alumni role does not grant the member programme discount.
- VIP has no administration access. Its membership expiry date is ignored and responses expose nonExpiring: true. Account status and Alumni tier restrictions still apply. If a subscription exists, fresh Stripe verification and payment eligibility remain required; VIP does not bypass billing holds, cancel billing or grant a paid Alumni tier.
- Admin and Super Admin can use administration during billing-only locked/payment_awaiting states. Frozen/suspended status blocks administration for everyone. Other staff roles require active status.
- No additional Super Admin-only page was found in the current routes. The role is separately defined and protected from removing/deactivating the last active Super Admin.

## Existing permission gaps to review

These remaining items were found while tracing the current behavior:

- Subscription account conversions preserve administrative assignments. Existing/migrated Alumni records are not automatically stripped of old regional roles until saved through this panel. This change restricts panel assignments; it is not a bulk database cleanup or conversion-policy change.

The authorization middleware binds regional event and member access to the signed
access token's region. A region change invalidates the old access token and
requires a new sign-in. Current database roles and token roles must both
permit an action, so a newly granted all-region role also needs a new token.
Regional event drafts, management actions, guest lists, manual
ticket creation and analytics use that scope. Public event details remain public.

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
