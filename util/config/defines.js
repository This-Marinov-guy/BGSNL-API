export const REGIONS = [
  "amsterdam",
  "breda",
  "eindhoven",
  "groningen",
  "leeuwarden",
  "maastricht",
  "rotterdam",
];

export const DEFAULT_REGION = "netherlands";

//routes and urls
export const BGSNL_URL = "bulgariansociety.nl/";
export const STRIPE_WEBHOOK_ROUTE = "/stripe-payments";

// authorization
export const PROD_JWT_TIMEOUT = "15m";
export const DEV_JWT_TIMEOUT = "1h";

// member roles
export const SUPER_ADMIN = "super_admin";
export const ADMIN = "admin";
export const SOCIETY_ADMIN = "society_board_member";
export const BOARD_MEMBER = "board_member";
export const COMMITTEE_MEMBER = "committee_member";
export const MEMBER = "member";
export const ALUMNI = "alumni";
export const VIP = "vip";

export const ACCESS_1 = [SUPER_ADMIN];
export const ACCESS_2 = [...ACCESS_1, ADMIN, SOCIETY_ADMIN];
export const ACCESS_3 = [...ACCESS_2, BOARD_MEMBER];
export const ACCESS_4 = [...ACCESS_3, COMMITTEE_MEMBER];

export const LIMITLESS_ACCOUNT = [SUPER_ADMIN, ADMIN, VIP];

// event status
export const EVENT_OPENED = "opened";
export const EVENT_CLOSED = "closed";
export const EVENT_SALE_STOP = "temporary closed";
export const EVENT_CANCELED = "canceled";

// email template uuids
export const GUEST_TICKET_TEMPLATE = "c30fa99f-9fcf-4ef2-ba7a-144c0c98f197";
export const MEMBER_TICKET_TEMPLATE = "277d4a81-d102-4cc3-8a61-9d1854147d55";
export const NEW_PASS_TEMPLATE = "824f447b-0ca1-4dcf-9c10-223d71cf48eb";
export const WELCOME_TEMPLATE = "f6eb08e8-7e2d-4abe-9edf-1c874ae49035";
export const CONTEST_MATERIALS_TEMPLATE =
  "c130f73a-17f7-4fe8-be84-4acf9d5d2800";
export const MEMBERSHIP_EXPIRED_TEMPLATE =
  "12db74ea-e568-4309-a64f-d543b909a520";
export const DELOITTE_TEMPLATE = "7e8088d0-3408-4875-ae5d-21a810fe0c7d";
export const PWC_TEMPLATE = "5947c9b6-795a-4bb7-aa23-916b317a8156";
export const ALUMNI_TEMPLATE = "55b52240-b23e-4109-b0f4-2741989be36d";

export const NO_REPLY_EMAIL = "no-reply@bulgariansociety.nl";
export const NO_REPLY_EMAIL_NAME = "Bulgarian Society Netherlands";

// periods of subscription
export const MONTHS_6 = "price_1QOg1FAShinXgMFZ1dZiQn1P";
export const YEAR_1 = "price_1QOg1XAShinXgMFZyH0F4P9i";

export const SUBSCRIPTIONS = [
  {
    id: MONTHS_6,
    amount: 600,
    period: 6,
  },
  {
    id: YEAR_1,
    amount: 1000,
    period: 12,
  },
];

// get the period of subscription by passing id DO NOT TOUCH!!!
export const SUBSCRIPTION_PERIOD_BY_ID = SUBSCRIPTIONS.reduce((acc, sub) => {
  acc[sub.id] = sub.period;
  return acc;
}, {});

// get the id of subscription by passing the amount DO NOT TOUCH!!!
export const SUBSCRIPTION_ID_BY_AMOUNT = SUBSCRIPTIONS.reduce((acc, sub) => {
  acc[sub.amount] = sub.id;
  return acc;
}, {});

export const HOME_URL = "https://bulgariansociety.nl";
export const USER_URL = `${HOME_URL}/user`;

export const DEFAULT_WP_TITLES = [
  "The Art of&nbsp;Connection",
  "Beyond the Obstacle",
  "Growth Unlocked",
  "Collaboration Magic",
];
