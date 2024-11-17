import dotenv from 'dotenv';
dotenv.config();
import Stripe from 'stripe';

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
    publishableKey: process.env.STRIPE_NL_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_NL_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_NL_WEBHOOK_CH_KEY,
  },
  leeuwarden: {
    publishableKey: process.env.STRIPE_GRO_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_GRO_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_GRO_WEBHOOK_CH_KEY,
  },
  breda: {
    publishableKey: process.env.STRIPE_GRO_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_GRO_SECRET_KEY,
    webhookSecretKey: process.env.STRIPE_GRO_WEBHOOK_CH_KEY,
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

  return new Stripe(STRIPE_KEYS[region]['secretKey'], {
    apiVersion: '2022-08-01',
  });
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
