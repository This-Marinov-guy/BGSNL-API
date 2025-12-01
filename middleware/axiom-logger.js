import dotenv from 'dotenv';
dotenv.config();
import { Axiom } from '@axiomhq/js';

const MAX_BODY_SIZE = 128 * 1024; // 128KB
const DATASET = process.env.AXIOM_DATASET || 'api-logs';

let axiom;
try {
  axiom = new Axiom({
    token: process.env.AXIOM_TOKEN,
    orgId: process.env.AXIOM_ORG_ID,
  });
} catch (err) {
  console.error('[axiom] client init failed:', err);
}

const safeJsonParse = (str) => {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
};

const truncateIfNeeded = (buffer) => {
  if (buffer.length <= MAX_BODY_SIZE) return buffer;

  return Buffer.concat([
    buffer.subarray(0, MAX_BODY_SIZE),
    Buffer.from('\n/* truncated */'),
  ]);
};

const formatRequest = (req) => ({
  method: req.method,
  url: req.originalUrl || req.url,
  path: req.path,
  params: req.params,
  query: req.query,
  ip: req.ip,
  headers: {
    'user-agent': req.headers['user-agent'],
    'content-type': req.headers['content-type'],
    accept: req.headers.accept,
    host: req.headers.host,
  },
  timestamp: new Date().toISOString(),
});

/**
 * Production-safe Axiom logger
 */
const axiomLogger = (req, res, next) => {
  if (
    !axiom ||
    process.env.APP_ENV === 'dev' ||
    !process.env.AXIOM_TOKEN ||
    !process.env.AXIOM_ORG_ID
  ) {
    return next();
  }

  const startTime = Date.now();
  const requestData = formatRequest(req);
  if (req.body) requestData.body = req.body;

  const chunks = [];
  let totalSize = 0;

  const originalWrite = res.write;
  const originalEnd = res.end;

  res.write = function (chunk, ...args) {
    try {
      if (chunk) {
        totalSize += chunk.length;
        if (totalSize <= MAX_BODY_SIZE) {
          chunks.push(Buffer.from(chunk));
        }
      }
    } catch (err) {
      console.error('[axiom] capture write failed:', err);
    }
    return originalWrite.apply(res, [chunk, ...args]);
  };

  res.end = function (chunk, ...args) {
    try {
      if (chunk) {
        totalSize += chunk.length;
        if (totalSize <= MAX_BODY_SIZE) {
          chunks.push(Buffer.from(chunk));
        }
      }
    } catch (err) {
      console.error('[axiom] capture end failed:', err);
    }

    originalEnd.apply(res, [chunk, ...args]);

    // Fire-and-forget logging
    (async () => {
      try {
        const responseTime = Date.now() - startTime;

        let responseBody;
        if (chunks.length) {
          const bodyBuffer = truncateIfNeeded(Buffer.concat(chunks));
          responseBody = safeJsonParse(bodyBuffer.toString('utf8'));
        }

        const logEvent = {
          request: requestData,
          response: {
            statusCode: res.statusCode,
            headersSent: res.headersSent,
            timeMs: responseTime,
            sizeBytes: totalSize,
            ...(responseBody && { body: responseBody }),
          },
          meta: {
            env: process.env.NODE_ENV || 'development',
            service: 'bgsnl-api',
          },
        };

        await axiom.ingestEvents(DATASET, [logEvent]);
      } catch (err) {
        console.error('[axiom] ingestion failed:', {
          message: err?.message,
          stack: err?.stack,
        });
      }
    })();
  };

  next();
};

export default axiomLogger;

