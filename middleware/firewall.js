import HttpError from "../models/Http-error.js";
import NodeCache from "node-cache";
import { allowedIps, allowedOrigins } from "../util/config/access.js";

const cache = new NodeCache({ stdTTL: 3600, checkperiod: 3600 });

export const rateLimiter = (req, res, next) => {
    if (req.method === 'GET') return next();

    const ip = req.ip;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - 3600; // 1 hour ago
    const maxRequests = 100;

    let entry = cache.get(ip);
    if (!entry) {
        cache.set(ip, [now]);
        return next();
    }

    entry = entry.filter(timestamp => timestamp > windowStart);

    if (entry.length >= maxRequests) {
        return next(new HttpError('Rate limit exceeded. Try again later!', 429))
    }

    entry.push(now);
    cache.set(ip, entry);
    next();
};

export const firewall = (req,res,next) => {
    const origin = req.headers.origin;
    const connectingIp = req.headers['do-connecting-ip'];

    if (allowedOrigins.includes(origin) || allowedIps.includes(connectingIp)) {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return next();
    } else {
        return next(new HttpError('Forbidden: Access is denied!', 403))
        res.status(403).json({ message: 'Forbidden: Access is denied' });
    }
}