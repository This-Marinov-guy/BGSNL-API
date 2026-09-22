import { MIGRATION_ID, upgradeProductionEvents } from "../services/events/event-production-upgrade.js";

export default {
  id: MIGRATION_ID,
  async up(db) {
    const summary = await upgradeProductionEvents(db, { apply: true });
    console.log(`[${MIGRATION_ID}] ${JSON.stringify(summary)}`);
  },
};
