import { redisRecordStore } from "../services/storage/redis-records.js";

export default redisRecordStore("payment-return", { ttlMs: 604800000 });
