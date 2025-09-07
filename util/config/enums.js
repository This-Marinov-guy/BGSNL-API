// USER STATUS
export const ACTIVE = 'active';
export const LOCKED = 'locked';
export const SUSPENDED = 'suspended';
export const ALUMNI = 'alumni-migrated';

export const USER_STATUSES = {
  [ACTIVE]: ACTIVE,
  [LOCKED]: LOCKED,
  [SUSPENDED]: SUSPENDED,
  [ALUMNI]: ALUMNI,
};

// Ticket types
export const GUEST = 'guest';
export const MEMBER = 'member';
export const ACTIVE_MEMBER = 'active member';
export const FREE = "free";

export const TICKET_TYPES = {
  [GUEST]: GUEST,
  [MEMBER]: MEMBER,
  [ACTIVE_MEMBER]: ACTIVE_MEMBER,
  [FREE]: FREE,
};