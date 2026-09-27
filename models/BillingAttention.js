import { redisRecordStore } from "../services/storage/redis-records.js";
import { reminderDeadline } from "../services/storage/retention.js";
// No job survives beyond 30 days from the start of its failure episode.
export default redisRecordStore("billing-reminder", {
  expiresAtFor: reminderDeadline,
});
