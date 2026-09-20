import test from 'node:test';
import assert from 'node:assert/strict';
import { audiencesForPromo, checkoutPromoAudience, prepareEventPromoCheckout, syncEventPromoCodes, validEventPromoCodes } from '../services/tickets/event-promo-codes.js';
import { ACTIVE_MEMBER, MEMBER } from '../util/config/defines.js';
const now = Date.now();
const input = { code: 'SAVE20', discountType: 2, discount: 20, active: true, audiences: ['guest', 'member', 'activeMember'] };
const saved = { ...input, id: 'coupon_1', couponId: 'coupon_1', customerScoped: true };
function harness({ codes = [saved], valid = true, used = 0, limit = null } = {}) {
  const calls = { coupons: [], promotions: [], retired: [], customers: [], removed: [] };
  let counter = 0;
  const stripe = {
    coupons: { create: async data => { calls.coupons.push(data); return { id: `coupon_new${++counter}` }; }, retrieve: async () => ({ valid, times_redeemed: used, max_redemptions: limit }), del: async id => calls.removed.push(id) },
    customers: { create: async data => { calls.customers.push(data); return { id: `cus_${++counter}` }; }, del: async id => calls.removed.push(id) },
    promotionCodes: { list: async function* () {}, retrieve: async () => ({ times_redeemed: used }), create: async data => { calls.promotions.push(data); return { id: `promo_${++counter}` }; }, update: async (id, data) => calls.retired.push({ id, ...data }) },
  };
  return { stripe, calls, event: { product: { promoCodes: codes } } };
}
const checkoutData = { mode: 'payment', allow_promotion_codes: true, customer_email: 'test@example.test', metadata: {} };

test('promo validation accepts optional limits and rejects malformed values and empty audiences', () => {
  assert.equal(validEventPromoCodes([input]), true);
  assert.equal(validEventPromoCodes([{ ...input, audiences: undefined }]), true);
  assert.equal(validEventPromoCodes([{ ...input, code: ' save 20 ' }]), true);
  assert.deepEqual(audiencesForPromo({}), ['guest', 'member']);
  for (const change of [{ audiences: [] }, { audiences: ['admin'] }, { useLimit: 1.5 }, { useLimit: 0 }, { discount: 101 }, { timeLimit: 'bad' }, { code: ' ' }]) assert.equal(validEventPromoCodes([{ ...input, ...change }]), false);
  assert.equal(validEventPromoCodes([input, { ...input, code: 'save20' }]), false);
  assert.equal(validEventPromoCodes([input, { ...input, code: 'S A V E 2 0' }]), false);
});
test('promo code names are stored without whitespace and in uppercase', async () => {
  const h = harness({ codes: [] });
  const [result] = await syncEventPromoCodes(h.stripe, 'prod_event', [{ ...input, code: ' save 20 ' }], [], now);
  assert.equal(result.code, 'SAVE20');
  assert.equal(h.calls.coupons[0].metadata.code, 'SAVE20');
});
test('audience comes from verified account entitlements, with distinct active members', () => {
  const account = { roles: [MEMBER], status: 'active', expireDate: new Date(now + 86400000) };
  assert.equal(checkoutPromoAudience('member', account), 'member');
  assert.equal(checkoutPromoAudience('member', { ...account, roles: [ACTIVE_MEMBER] }), 'activeMember');
  assert.equal(checkoutPromoAudience('guest', { ...account, roles: [ACTIVE_MEMBER] }), 'guest');
  assert.equal(checkoutPromoAudience('member', { ...account, status: 'locked' }), 'guest');
});
test('new percentage and fixed codes create event-only coupons with shared limits', async () => {
  const h = harness();
  const result = await syncEventPromoCodes(h.stripe, 'prod_event', [{ ...input, useLimit: 12, timeLimit: new Date(now + 86400000).toISOString() }, { ...input, code: 'FIVE', discountType: 1, discount: 5 }], [], now);
  assert.deepEqual(h.calls.coupons[0].applies_to, { products: ['prod_event'] });
  assert.equal(h.calls.coupons[0].max_redemptions, 12);
  assert.equal(h.calls.coupons[0].redeem_by, Math.floor((now + 86400000) / 1000));
  assert.equal(h.calls.coupons[1].amount_off, 500);
  assert.equal(h.calls.coupons[1].currency, 'eur');
  assert.equal(result[0].customerScoped, true);
  assert.deepEqual(result[0].audiences, input.audiences);
  assert.equal(h.calls.promotions.length, 0);
});
test('Stripe field stays enabled and only the eligible customer gets restricted codes', async () => {
  for (const audience of ['guest', 'member', 'activeMember']) {
    const h = harness({ codes: [{ ...saved, audiences: ['member'] }] });
    const result = await prepareEventPromoCheckout({ ...h, audience, checkoutData, now });
    assert.equal(result.allow_promotion_codes, true);
    assert.equal(h.calls.promotions.length, audience === 'member' ? 1 : 0);
    if (audience === 'member') {
      assert.equal(h.calls.promotions[0].customer, result.customer);
      assert.equal(h.calls.promotions[0].coupon, saved.couponId);
      assert.equal(result.customer_email, undefined);
      assert.equal(h.calls.promotions[0].expires_at, result.expires_at);
    }
  }
});
test('separate checkouts cannot reuse a formerly eligible customer identity', async () => {
  const h = harness();
  const first = await prepareEventPromoCheckout({ ...h, audience: 'member', checkoutData, now });
  const second = await prepareEventPromoCheckout({ ...h, audience: 'member', checkoutData, now });
  assert.notEqual(first.customer, second.customer);
});
test('expired, disabled and exhausted codes do not become available in checkout', async () => {
  for (const patch of [{ active: false }, { exhausted: true }, { timeLimit: new Date(now - 1000).toISOString() }]) {
    const h = harness({ codes: [{ ...saved, ...patch }] });
    await prepareEventPromoCheckout({ ...h, audience: 'guest', checkoutData, now });
    assert.equal(h.calls.promotions.length, 0);
  }
  for (const settings of [{ valid: false }, { limit: 2, used: 2 }]) {
    const h = harness(settings);
    await prepareEventPromoCheckout({ ...h, audience: 'guest', checkoutData, now });
    assert.equal(h.calls.promotions.length, 0);
  }
});
test('omission preserves codes; disabling removes codes and retires Stripe entry', async () => {
  const old = { ...saved, id: 'promo_old', customerScoped: false };
  const h = harness();
  assert.deepEqual(await syncEventPromoCodes(h.stripe, 'prod_event', undefined, [old]), [old]);
  assert.deepEqual(await syncEventPromoCodes(h.stripe, 'prod_event', [], [old]), []);
  assert.deepEqual(h.calls.retired, [{ id: 'promo_old', active: false }]);
});
test('audience edits retain the shared coupon and retire previously issued codes', async () => {
  const h = harness();
  h.stripe.promotionCodes.list = async function* (query) { if (query.coupon) yield { id: 'promo_issued' }; };
  const result = await syncEventPromoCodes(h.stripe, 'prod_event', [{ ...saved, audiences: ['member'] }], [saved]);
  assert.equal(result[0].couponId, saved.couponId);
  assert.equal(h.calls.coupons.length, 0);
  assert.deepEqual(h.calls.retired, [{ id: 'promo_issued', active: false }]);
});
test('legacy audience changes preserve already-used redemptions', async () => {
  const old = { ...input, id: 'promo_old', couponId: 'coupon_old', useLimit: 10 };
  const h = harness({ used: 4 });
  const result = await syncEventPromoCodes(h.stripe, 'prod_event', [{ ...old, audiences: ['member'] }], [old]);
  assert.equal(h.calls.coupons[0].max_redemptions, 6);
  assert.equal(result[0].redeemedBefore, 4);
  assert.equal(result[0].useLimit, 10);
  assert.equal(result[0].customerScoped, true);
});
test('published economics cannot silently reset redemption limits', async () => {
  const h = harness();
  await assert.rejects(syncEventPromoCodes(h.stripe, 'prod_event', [{ ...saved, discount: 30 }], [saved]), /Create a new promo code/);
  assert.equal(h.calls.coupons.length, 0);
});
test('unknown promo IDs and conflicting global code names are rejected', async () => {
  const h = harness();
  await assert.rejects(syncEventPromoCodes(h.stripe, 'prod_event', [saved], []), /does not belong/);
  h.stripe.promotionCodes.list = async function* () { yield { id: 'promo_elsewhere', customer: null }; };
  await assert.rejects(syncEventPromoCodes(h.stripe, 'prod_event', [input], []), /already in use/);
});
test('failed coupon creation aborts save and cleans up newly created coupons', async () => {
  const h = harness();
  const create = h.stripe.coupons.create;
  h.stripe.coupons.create = async data => { if (h.calls.coupons.length) throw new Error('Stripe unavailable'); return create(data); };
  await assert.rejects(syncEventPromoCodes(h.stripe, 'prod_event', [input, { ...input, code: 'SECOND' }]), /Stripe unavailable/);
  assert.equal(h.calls.removed.length, 1);
});
test('minimum spend and configured expiry are carried to customer-specific Stripe codes', async () => {
  const h = harness({ codes: [{ ...saved, minAmount: 10, timeLimit: new Date(now + 600000).toISOString() }] });
  await prepareEventPromoCheckout({ ...h, audience: 'guest', checkoutData, now });
  assert.equal(h.calls.promotions[0].restrictions.minimum_amount, 1000);
  assert.equal(h.calls.promotions[0].expires_at, Math.floor((now + 600000) / 1000));
});

test('real session adapter scopes codes for both normal and one-click checkout without changing Stripe entry', async () => {
  const { createTicketCheckoutSession } = await import('../controllers/payments-controllers.js');
  const h = harness();
  let sent;
  const result = await createTicketCheckoutSession({ stripeClient: h.stripe, event: h.event, eventId: 'event_1', checkoutType: 'guest', checkoutData: { ...checkoutData, metadata: { region: 'groningen' } } }, {
    createReturned: async args => { sent = args.checkoutData; return { url: 'https://checkout.stripe.com/mock' }; },
  });
  assert.equal(sent.allow_promotion_codes, true);
  assert.ok(sent.customer);
  assert.equal(sent.customer_email, undefined);
  assert.equal(result.url, 'https://checkout.stripe.com/mock');
});
test('cached member checkout is replaced when promo eligibility changes and then reused', async () => {
  const { createTicketCheckoutSession } = await import('../controllers/payments-controllers.js');
  const h = harness();
  const record = { data: { sessionId: 'cs_old', sessionUrl: 'old', expiresAt: Math.floor(now / 1000) + 1800, promoSignature: 'old-audience' } };
  const expired = [];
  let creations = 0;
  h.stripe.checkout = { sessions: { expire: async id => expired.push(id) } };
  const args = { stripeClient: h.stripe, event: h.event, eventId: 'event_1', checkoutType: 'member', userId: 'member_1', member: { roles: [MEMBER], status: 'active', expireDate: new Date(now + 86400000) }, checkoutData: { ...checkoutData, metadata: { region: 'groningen' } } };
  const deps = {
    hasDuplicate: async () => false,
    lease: async (key, run) => run({ record, assertOwned: async () => {} }),
    updateRecord: async (query, update) => { record.data = update.$set.data; },
    createReturned: async () => { creations++; return { id: 'cs_new', url: 'new' }; },
  };
  assert.deepEqual(await createTicketCheckoutSession(args, deps), { url: 'new' });
  assert.deepEqual(expired, ['cs_old']);
  assert.equal(creations, 1);
  assert.deepEqual(await createTicketCheckoutSession(args, deps), { url: 'new' });
  assert.equal(creations, 1);
});
