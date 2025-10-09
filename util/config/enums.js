// USER STATUS
export const ACTIVE = 'active';
export const LOCKED = 'locked';
export const SUSPENDED = 'suspended';
export const ALUMNI_MIGRATED = 'alumni-migrated';

export const USER_STATUSES = {
  [ACTIVE]: ACTIVE,
  [LOCKED]: LOCKED,
  [SUSPENDED]: SUSPENDED,
  [ALUMNI_MIGRATED]: ALUMNI_MIGRATED,
};

// Ticket types
export const GUEST = 'guest';
export const MEMBER = 'member';
export const ALUMNI = 'alumni';
export const ACTIVE_MEMBER = 'active member';
export const FREE = "free";

export const TICKET_TYPES = {
  [GUEST]: GUEST,
  [MEMBER]: MEMBER,
  [ACTIVE_MEMBER]: ACTIVE_MEMBER,
  [FREE]: FREE,
};

export const BILLING_PORTAL_CONFIGURATIONS = {
  [MEMBER]: "bpc_1SGDq4AShinXgMFZfac1vY22",
  [ALUMNI]: "bpc_1SGDptAShinXgMFZ4yLZnEOC",
};