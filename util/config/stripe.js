import dotenv from 'dotenv';
dotenv.config();
import Stripe from 'stripe';

export const STRIPE_KEYS = {
  groningen: {
    publishableKey: process.env.STRIPE_GRO_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_GRO_SECRET_KEY,
    webhookSecretKey: 'whsec_ngneD8G5SlOB1rE3an9VttnRu3LFXHSq',
  },
  amsterdam: {
    publishableKey: process.env.STRIPE_AMS_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_AMS_SECRET_KEY,
    webhookSecretKey: 'whsec_bvI31HIjqsatK5IhptzC1n7qXSg5tZrJ',
  },
  rotterdam: {
    publishableKey: process.env.STRIPE_GRO_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_GRO_SECRET_KEY,
    webhookSecretKey: 'whsec_ngneD8G5SlOB1rE3an9VttnRu3LFXHSq',
  },
  leeuwarden: {
    publishableKey: process.env.STRIPE_GRO_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_GRO_SECRET_KEY,
    webhookSecretKey: 'whsec_ngneD8G5SlOB1rE3an9VttnRu3LFXHSq',
  },
  breda: {
    publishableKey: process.env.STRIPE_GRO_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_GRO_SECRET_KEY,
    webhookSecretKey: 'whsec_ngneD8G5SlOB1rE3an9VttnRu3LFXHSq',
  },
  eindhoven: {
    publishableKey: process.env.STRIPE_GRO_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_GRO_SECRET_KEY,
    webhookSecretKey: 'whsec_ngneD8G5SlOB1rE3an9VttnRu3LFXHSq',
  },
  maastricht: {
    publishableKey: process.env.STRIPE_GRO_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_GRO_SECRET_KEY,
    webhookSecretKey: 'whsec_ngneD8G5SlOB1rE3an9VttnRu3LFXHSq',
  },
  netherlands: {
    publishableKey: process.env.STRIPE_GRO_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_GRO_SECRET_KEY,
    webhookSecretKey: 'whsec_ngneD8G5SlOB1rE3an9VttnRu3LFXHSq',
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
