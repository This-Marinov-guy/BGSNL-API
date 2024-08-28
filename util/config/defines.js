// member roles
export const SUPER_ADMIN = 'super_admin';
export const ADMIN = 'admin';
export const SOCIETY_ADMIN = 'society_board_member';
export const BOARD_MEMBER = 'board_member';
export const COMMITTEE_MEMBER = 'committee_member';
export const MEMBER = 'member';
export const VIP = 'vip'

export const ACCESS_1 = [SUPER_ADMIN];
export const ACCESS_2 = [...ACCESS_1, ADMIN, SOCIETY_ADMIN];
export const ACCESS_3 = [...ACCESS_2, BOARD_MEMBER, COMMITTEE_MEMBER];

export const LIMITLESS_ACCOUNT = [SUPER_ADMIN, ADMIN, VIP];

// event status
export const EVENT_OPENED = 'opened';
export const EVENT_CLOSED = 'closed';
export const EVENT_SALE_STOP = 'temporary closed';
export const EVENT_CANCELED = 'canceled';

// email template uuids
export const GUEST_TICKET_TEMPLATE = 'c30fa99f-9fcf-4ef2-ba7a-144c0c98f197';
export const MEMBER_TICKET_TEMPLATE = '277d4a81-d102-4cc3-8a61-9d1854147d55';
export const NEW_PASS_TEMPLATE = '824f447b-0ca1-4dcf-9c10-223d71cf48eb';
export const WELCOME_TEMPLATE = 'f6eb08e8-7e2d-4abe-9edf-1c874ae49035';
export const CONTEST_MATERIALS_TEMPLATE = 'c130f73a-17f7-4fe8-be84-4acf9d5d2800';

export const NO_REPLY_EMAIL = "no-reply@bulgariansociety.nl";
export const NO_REPLY_EMAIL_NAME = "Bulgarian Society Netherlands"

// periods of subscription
const MONTHS_6 = 'price_1OuqmtIOw5UGbAo1V4TqMet4';
const YEAR_1 = 'price_1Otbd6IOw5UGbAo1rdJ7wXp3';

export const SUBSCRIPTION_PERIOD = {
    [MONTHS_6]: 6,
    [YEAR_1]: 12
}