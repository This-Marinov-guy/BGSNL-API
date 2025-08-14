import dotenv from 'dotenv';
dotenv.config();
import { Axiom } from '@axiomhq/js';

// Create and initialize Axiom client
let axiom;
try {
  axiom = new Axiom({
    token: process.env.AXIOM_TOKEN,
    orgId: process.env.AXIOM_ORG_ID,
  });
} catch (error) {
  console.error('Failed to initialize Axiom client:', error);
}

// Define the dataset to use
const DATASET = process.env.AXIOM_DATASET || 'api-logs';

/**
 * Format request details for logging
 */
const formatRequest = (req) => {
  return {
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.path,
    params: req.params,
    query: req.query,
    headers: {
      'user-agent': req.headers['user-agent'],
      'content-type': req.headers['content-type'],
      'accept': req.headers['accept'],
      'host': req.headers['host'],
      'referer': req.headers['referer'],
      'origin': req.headers['origin'],
    },
    ip: req.ip,
    timestamp: new Date().toISOString(),
  };
};

/**
 * Middleware to log API requests and responses to Axiom
 */
export const axiomLogger = (req, res, next) => {
  // Skip logging in development environment
  if (!axiom || process.env.NODE_ENV === 'development') {
    return next();
  }

  // Record start time
  const startTime = Date.now();
  
  // Capture original request
  const requestData = formatRequest(req);
  
  // Create a reference to the original end method
  const originalEnd = res.end;
  const chunks = [];
  
  // Capture response body
  res.write = function (chunk) {
    chunks.push(Buffer.from(chunk));
    return res.constructor.prototype.write.apply(this, arguments);
  };

  // Override the end method to log the response
  res.end = function (chunk) {
    // If there's a chunk, add it to the array
    if (chunk) {
      chunks.push(Buffer.from(chunk));
    }
    
    // Execute the original end method
    originalEnd.apply(res, arguments);
    
    // Calculate response time
    const responseTime = Date.now() - startTime;

    // Log to Axiom
    try {
      const logData = {
        request: requestData,
        response: {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res._header,
          time: responseTime,
          size: res.getHeader('content-length') || 0,
        },
        meta: {
          environment: process.env.NODE_ENV || 'development',
          service: 'bgsnl-api',
        }
      };
      
      // Don't log request bodies or responses if they might contain sensitive data
      // or if they're too large
      if (req.path.startsWith('/api/security') || 
          req.path.startsWith('/api/user')) {
        logData.request.body = '<redacted>';
        logData.response.body = '<redacted>';
      }
      
      axiom.ingest(DATASET, logData)
        .catch(err => console.error('Failed to send logs to Axiom:', err));
    } catch (err) {
      console.error('Error logging to Axiom:', err);
    }
  };
  
  next();
};

export default axiomLogger;
