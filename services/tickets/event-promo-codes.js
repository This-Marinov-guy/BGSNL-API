import HttpError from "../../models/Http-error.js";
import { ACCESS_4 } from "../../util/config/defines.js";
import { accountEntitlements } from "../../util/subscriptions/policy.js";

export const PROMO_AUDIENCES = ["guest", "member", "activeMember"];
export const DEFAULT_PROMO_AUDIENCES = ["guest", "member"];
export const audiencesForPromo = promo => promo.audiences ?? DEFAULT_PROMO_AUDIENCES;
export const normalizeEventPromoCode = code => typeof code === "string" ? code.replace(/\s+/g, "").toUpperCase() : "";
const numberOrNull = value => value === "" || value == null ? null : Number(value);
const timestamp = value => value ? Math.floor(new Date(value).getTime() / 1000) : null;
const terms = promo => JSON.stringify([Number(promo.discountType), Number(promo.discount), numberOrNull(promo.useLimit), timestamp(promo.timeLimit), numberOrNull(promo.minAmount)]);
const plain = value => value?.toObject ? value.toObject() : { ...value };

export function validEventPromoCodes(codes) {
  return Array.isArray(codes) && codes.length <= 100 && new Set(codes.map(promo => normalizeEventPromoCode(promo?.code))).size === codes.length && codes.every(promo =>
    promo && typeof promo.code === "string" && /^[A-Z0-9-]{1,100}$/.test(normalizeEventPromoCode(promo.code)) &&
    [1, 2].includes(Number(promo.discountType)) && Number.isFinite(Number(promo.discount)) && Number(promo.discount) >= 0.01 &&
    (Number(promo.discountType) !== 2 || Number(promo.discount) <= 100) &&
    (numberOrNull(promo.useLimit) === null || (Number.isSafeInteger(Number(promo.useLimit)) && Number(promo.useLimit) >= 1)) &&
    (numberOrNull(promo.minAmount) === null || (Number.isFinite(Number(promo.minAmount)) && Number(promo.minAmount) >= 0.01)) &&
    (!promo.timeLimit || Number.isFinite(timestamp(promo.timeLimit))) &&
    Array.isArray(audiencesForPromo(promo)) && audiencesForPromo(promo).length > 0 && audiencesForPromo(promo).every(audience => PROMO_AUDIENCES.includes(audience)) &&
    (promo.active === undefined || [true, false, "true", "false"].includes(promo.active)));
}

export function checkoutPromoAudience(checkoutType, member) {
  if (checkoutType !== "member" || !accountEntitlements(member).memberDiscount) return "guest";
  return member.roles?.some(role => ACCESS_4.includes(role)) ? "activeMember" : "member";
}

async function retirePromotionCodes(stripe, promo) {
  if (!promo.customerScoped) {
    await stripe.promotionCodes.update(promo.id, { active: false });
    return;
  }
  for await (const code of stripe.promotionCodes.list({ coupon: promo.couponId, active: true, limit: 100 })) {
    await stripe.promotionCodes.update(code.id, { active: false });
  }
}

// Coupon economics stay immutable after publication: changing them would reset
// Stripe's redemption counter. Audience, name and active state remain editable.
export async function syncEventPromoCodes(stripe, productId, incoming, existing = [], now = Date.now()) {
  if (incoming == null) return existing;
  if (!validEventPromoCodes(incoming)) throw new HttpError("Check the promo-code names, discounts, limits and audiences.", 422);
  if (incoming.length && !productId) throw new HttpError("Paid tickets are required for promo codes.", 422);
  const prepared = [];
  const created = [];
  const retire = [];
  try {
    for (const input of incoming) {
      const old = input.id ? existing.find(promo => promo.id === input.id) : null;
      if (input.id && !old) throw new HttpError("This promo code does not belong to the event.", 422);
      if (old && terms(input) !== terms(old)) throw new HttpError("Create a new promo code to change a published discount, expiration or redemption limit.", 422);
      const code = normalizeEventPromoCode(input.code);
      const audiences = [...new Set(audiencesForPromo(input))];
      const active = input.active !== false && input.active !== "false";
      if (old && code === normalizeEventPromoCode(old.code) && active === old.active && JSON.stringify([...audiences].sort()) === JSON.stringify([...audiencesForPromo(old)].sort())) {
        prepared.push(plain(old)); continue;
      }
      // An active global code with this spelling would bypass customer scoping.
      for await (const candidate of stripe.promotionCodes.list({ code, active: true, limit: 100 })) {
        if (!candidate.customer && candidate.id !== old?.id) throw new HttpError(`The code ${code} is already in use. Choose another name.`, 422);
      }
      if (old?.customerScoped) {
        retire.push(old);
        prepared.push({ ...plain(old), code, audiences, active });
        continue;
      }
      const expires = timestamp(input.timeLimit);
      if (!old && expires && (expires <= now / 1000 || expires > now / 1000 + 5 * 365 * 86400)) throw new HttpError("Choose a future promo expiration within five years.", 422);
      const redeemedBefore = old ? Number((await stripe.promotionCodes.retrieve(old.id)).times_redeemed || 0) : 0;
      const limit = numberOrNull(input.useLimit);
      const exhausted = Boolean(limit && redeemedBefore >= limit);
      const coupon = await stripe.coupons.create({
        duration: "once", applies_to: { products: [productId] },
        ...(Number(input.discountType) === 1 ? { amount_off: Math.round(Number(input.discount) * 100), currency: "eur" } : { percent_off: Number(input.discount) }),
        ...(limit ? { max_redemptions: Math.max(1, limit - redeemedBefore) } : {}),
        ...(expires && expires > now / 1000 ? { redeem_by: expires } : {}),
        metadata: { purpose: "event_promo", productId, code },
      });
      created.push(coupon.id);
      if (old) retire.push(old);
      prepared.push({ id: coupon.id, couponId: coupon.id, customerScoped: true, code, audiences, active, exhausted, redeemedBefore,
        discountType: Number(input.discountType), discount: Number(input.discount), useLimit: limit,
        timeLimit: input.timeLimit || null, minAmount: numberOrNull(input.minAmount) });
    }
    for (const old of existing) if (!incoming.some(input => input.id === old.id)) retire.push(old);
    for (const old of retire) await retirePromotionCodes(stripe, old);
    return prepared;
  } catch (error) {
    await Promise.allSettled(created.map(id => stripe.coupons.del(id)));
    throw error;
  }
}

// A new customer per new Checkout session prevents a previously eligible buyer
// reusing a customer-restricted code after their membership changes. No customer
// or promotion-code IDs are written to our DB. Codes expire with the session.
export async function prepareEventPromoCheckout({ stripe, event, audience, checkoutData, now = Date.now() }) {
  const eligible = (event?.product?.promoCodes ?? []).filter(promo => promo.customerScoped && promo.active !== false && !promo.exhausted && audiencesForPromo(promo).includes(audience) && (!promo.timeLimit || timestamp(promo.timeLimit) > now / 1000));
  if (!eligible.length) return checkoutData;
  const coupons = await Promise.all(eligible.map(promo => stripe.coupons.retrieve(promo.couponId)));
  const available = eligible.filter((promo, index) => coupons[index].valid && (!coupons[index].max_redemptions || coupons[index].times_redeemed < coupons[index].max_redemptions));
  if (!available.length) return checkoutData;
  const expiresAt = checkoutData.expires_at || Math.floor(now / 1000) + 31 * 60;
  const email = checkoutData.customer_email || checkoutData.metadata?.guestEmail;
  const customer = await stripe.customers.create({ ...(email ? { email } : {}), metadata: { purpose: "event_ticket_checkout" } });
  const created = [];
  try {
    // Bound concurrency to avoid bursts when an event has many codes.
    for (let offset = 0; offset < available.length; offset += 5) {
      const results = await Promise.allSettled(available.slice(offset, offset + 5).map(async promo => {
        const code = await stripe.promotionCodes.create({ coupon: promo.couponId, code: promo.code, customer: customer.id,
          expires_at: Math.min(expiresAt, timestamp(promo.timeLimit) || expiresAt),
          ...(promo.minAmount ? { restrictions: { minimum_amount: Math.round(promo.minAmount * 100), minimum_amount_currency: "eur" } } : {}) });
        created.push(code.id);
      }));
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    }
    const data = { ...checkoutData, customer: customer.id, expires_at: expiresAt };
    delete data.customer_email;
    return data;
  } catch (error) {
    await Promise.allSettled(created.map(id => stripe.promotionCodes.update(id, { active: false })));
    await stripe.customers.del(customer.id).catch(() => {});
    throw error;
  }
}
