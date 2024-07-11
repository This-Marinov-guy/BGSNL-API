import NodeCache from "node-cache";

export const requestCache = new NodeCache({ stdTTL: 3600, checkperiod: 3600 });

export const eventsCache = new NodeCache({ stdTTL: 24 * 3600 });

