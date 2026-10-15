import dotenv from 'dotenv';
dotenv.config();
import Stripe from 'stripe';
import { logIntegrationRequest } from '../../middleware/axiom-logger.js';

const STRIPE_RESOURCES = new Set(['accounts', 'balance', 'balance_transactions', 'billing_portal', 'charges',
  'checkout', 'coupons', 'customers', 'disputes', 'events', 'invoices', 'payment_intents', 'payment_methods',
  'prices', 'products', 'promotion_codes', 'refunds', 'subscriptions', 'transfers']);

// Stripe paths contain customer and payment IDs. Only retain the stable API
// resource so request activity can be debugged without storing those IDs.
export const stripeRequestOperation = (path) => {
  const segments = String(path || '').split('?')[0].split('/').filter(Boolean);
  if (segments[0] !== 'v1') return 'api-request';
  const resource = segments[1];
  if (!STRIPE_RESOURCES.has(resource)) return 'api-request';
  if (resource === 'checkout' && segments[2] === 'sessions') return 'checkout-sessions';
  if (resource === 'billing_portal' && ['sessions', 'configurations'].includes(segments[2])) {
    return `billing-portal-${segments[2]}`;
  }
  return resource.replaceAll('_', '-');
};

export const STRIPE_KEYS = {
  groningen: {
    publishableKey: process.env.STRIPE_GRO_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_GRO_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_GRO_WEBHOOK_CH_KEY,
  },
  amsterdam: {
    publishableKey: process.env.STRIPE_AMS_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_AMS_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_AMS_WEBHOOK_CH_KEY,
  },
  rotterdam: {
    publishableKey: process.env.STRIPE_RTM_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_RTM_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_RTM_WEBHOOK_CH_KEY,
  },
  leeuwarden: {
    publishableKey: process.env.STRIPE_LWD_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_LWD_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_LWD_WEBHOOK_CH_KEY,
  },
  breda_tilburg: {
    publishableKey: process.env.STRIPE_NL_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_NL_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_NL_WEBHOOK_CH_KEY,
  },
  eindhoven: {
    publishableKey: process.env.STRIPE_NL_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_NL_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_NL_WEBHOOK_CH_KEY,
  },
  maastricht: {
    publishableKey: process.env.STRIPE_NL_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_NL_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_NL_WEBHOOK_CH_KEY,
  },
  leiden_hague: {
    publishableKey: process.env.STRIPE_LDHG_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_LDHG_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_LDHG_WEBHOOK_CH_KEY,
  },
  netherlands: {
    publishableKey: process.env.STRIPE_NL_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_NL_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_NL_WEBHOOK_CH_KEY,
  },
  test: {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY_TEST,
    secretKey: process.env.STRIPE_SECRET_KEY_TEST,
    webhookSecretKey: process.env.STRIPE_WEBHOOK_CH_KEY,
  },
};

export const createStripeClient = (region = '') => {
  if (!region || !(region in STRIPE_KEYS)) {
    console.log(
      'createStripeClient: Warning region was either not passed or not valid | region: ' +
        region || '-'
    );
    region = 'netherlands';
  }

  const client = new Stripe(STRIPE_KEYS[region]['secretKey'], {
    apiVersion: '2022-08-01',
    timeout: 20000,
    maxNetworkRetries: 1,
  });
  client.on('response', ({ method, path, status, elapsed }) => {
    logIntegrationRequest('stripe', stripeRequestOperation(path), { method, status, durationMs: elapsed });
  });
  return client;
};

export const getStripeKey = (key, region = '') => {
  if (!region || !(region in STRIPE_KEYS)) {
    console.log(
      'getStripeKey: Warning region was either not passed or not valid | region: ' +
        region || '-'
    );
    region = 'netherlands';
  }

  return STRIPE_KEYS[region][key];
};
