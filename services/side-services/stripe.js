import dotenv from "dotenv";
dotenv.config();
import { MOMENT_DATE_YEAR } from '../../util/functions/dateConvert.js'
import { capitalizeFirstLetter } from '../../util/functions/helpers.js'
import moment from "moment";
import { createStripeClient } from "../../util/config/stripe.js";

export const stripeProductDescription = (region, name, date) => {
    console.log(region, name, date);
    if (!date || !name || !region) {
        return '';
    }

    return `Event Ticket for ${capitalizeFirstLetter(region)}'s ${name} on ${moment(date).format(MOMENT_DATE_YEAR)}`
}

export const addProduct = async (data, priceData = []) => {
    let product;
    const properties = {
        name: data['name'],
        images: [data['image']],
        description: stripeProductDescription(data['region'], data['name'], data['date'])
    }

    const stripeClient = createStripeClient(data['region']);

    try {
        product = await stripeClient.products.create(properties);

        // priceData.forEach(async (amount) => {
        //     const priceId = await addPrice(data['region'], product['id'], amount);

        //     if (priceId) {

        //     }
        // });
    } catch (err) {
        console.log(err);
        return false
    }

    return product['id'];
}

export const editProduct = async (region, productId, data) => {
    const stripeClient = createStripeClient(region);

    try {
        await stripeClient.products.update(
            productId,
            {
                ...data,
            }
        );
    } catch (err) {
        console.log(err);
        return false
    }

    return true;
}

export const deleteProduct = async (region, productId) => {
    if (!productId) {
        return false;
    }

    const stripeClient = createStripeClient(region);

    try {
        const prices = await stripeClient.prices.list({ product: productId });

        for (const price of prices.data) {
          await stripeClient.prices.update(price.id, { active: false });
          console.log(`Archived price: ${price.id}`);
        }

        await stripeClient.products.del(productId);
    } catch (err) {
        console.log(err);
        return false;
    }

    return true;
}

export const addPrice = async (region, productId, amount = 0, nickname = 'price') => {
    if (!amount) {
        return false;
    }

    const stripeClient = createStripeClient(region);

    let price;

    try {
        price = await stripeClient.prices.create({
            currency: 'eur',
            unit_amount: amount * 100,
            product: productId,
            nickname
        });
    } catch (err) {
        console.log(err);
        return false
    }

    return price['id'];
}

export const editPrice = async (region, priceId, data) => {
    const stripeClient = createStripeClient(region);

    try {
        await stripeClient.prices.update(
            priceId,
            {
                ...data
            }
        );
    } catch (err) {
        console.log(err);
        return false
    }

    return true;
}

// ============================================
// STRIPE PROMOCODE (COUPON + PROMOTION CODE) FUNCTIONS
// ============================================

/**
 * Validates promocode data before creating in Stripe
 */
const validatePromocodeData = (code, discountType, discount) => {
  const errors = [];

  if (!code || !discountType || discount === undefined || discount === null) {
    errors.push("Code, discountType, and discount are required fields");
  }

  if (discountType !== 1 && discountType !== 2) {
    errors.push("discountType must be 1 (fixed amount) or 2 (percentage)");
  }

  if (discount < 0) {
    errors.push("Discount cannot be negative");
  }

  if (discountType === 2 && discount > 100) {
    errors.push("Percentage discount cannot exceed 100%");
  }

  return errors;
};

/**
 * Check for duplicate promocode in array
 */
const checkPromocodeDuplicate = (promoCodes, code, excludeId = null) => {
  if (!promoCodes || promoCodes.length === 0) {
    return false;
  }

  return promoCodes.some(
    (promo) =>
      promo.code.toLowerCase() === code.toLowerCase() &&
      (!excludeId || promo.id !== excludeId)
  );
};

/**
 * Creates a Stripe Coupon restricted to a specific product
 * @param {string} region - Region for stripe client
 * @param {string} productId - Stripe product ID to restrict coupon to
 * @param {number} discountType - 1 for fixed amount, 2 for percentage
 * @param {number} discount - Discount value
 * @param {number} minAmount - Minimum amount in euros (optional)
 * @returns {string|null} - Coupon ID or null if failed
 */
export const createStripeCoupon = async (region, productId, discountType, discount, minAmount = null) => {
  const stripeClient = createStripeClient(region);

  try {
    const couponData = {
      currency: 'eur',
    };

    // Set discount type (amount_off for fixed, percent_off for percentage)
    if (discountType === 1) {
      // Fixed amount - convert euros to cents
      couponData.amount_off = Math.round(discount * 100);
    } else if (discountType === 2) {
      // Percentage
      couponData.percent_off = discount;
    }

    // Restrict coupon to specific product
    if (productId) {
      couponData.applies_to = {
        products: [productId]
      };
    }

    // Add minimum amount restriction if provided (convert to cents)
    if (minAmount !== null && minAmount !== undefined && minAmount > 0) {
      couponData.min_amount = Math.round(minAmount * 100);
      couponData.min_amount_currency = 'eur';
    }

    const coupon = await stripeClient.coupons.create(couponData);
    return coupon.id;
  } catch (err) {
    console.error('Error creating Stripe coupon:', err);
    return null;
  }
};

/**
 * Creates a Stripe Promotion Code
 * @param {string} region - Region for stripe client
 * @param {string} couponId - Stripe coupon ID
 * @param {string} code - The promocode string
 * @param {number} useLimit - Maximum redemptions (optional)
 * @param {Date} timeLimit - Expiration date (optional)
 * @returns {object|null} - Promotion code object with id and code, or null if failed
 */
export const createStripePromotionCode = async (region, couponId, code, useLimit = null, timeLimit = null) => {
  const stripeClient = createStripeClient(region);

  try {
    const promotionCodeData = {
      coupon: couponId,
      code: code.trim().toUpperCase(),
    };

    // Add max redemptions if provided
    if (useLimit !== null && useLimit !== undefined && useLimit > 0) {
      promotionCodeData.max_redemptions = useLimit;
    }

    // Add expiration date if provided (convert to Unix timestamp)
    if (timeLimit) {
      const expirationDate = new Date(timeLimit);
      promotionCodeData.expires_at = Math.floor(expirationDate.getTime() / 1000);
    }

    const promotionCode = await stripeClient.promotionCodes.create(promotionCodeData);
    
    return {
      id: promotionCode.id,
      code: promotionCode.code,
    };
  } catch (err) {
    console.error('Error creating Stripe promotion code:', err);
    return null;
  }
};

/**
 * Updates a Stripe Promotion Code (deactivates old, creates new if needed)
 * Note: Stripe doesn't allow updating promotion codes directly, so we deactivate and create new
 */
export const updateStripePromotionCode = async (
  region,
  existingPromoId,
  newCode,
  newCouponId,
  useLimit = null,
  timeLimit = null
) => {
  const stripeClient = createStripeClient(region);

  try {
    // Deactivate the old promotion code
    await stripeClient.promotionCodes.update(existingPromoId, {
      active: false,
    });

    // Create a new promotion code with updated settings
    return await createStripePromotionCode(
      region,
      newCouponId,
      newCode,
      useLimit,
      timeLimit
    );
  } catch (err) {
    console.error('Error updating Stripe promotion code:', err);
    return null;
  }
};

/**
 * Deactivates a Stripe Promotion Code
 */
export const deactivateStripePromotionCode = async (region, promoId) => {
  const stripeClient = createStripeClient(region);

  try {
    await stripeClient.promotionCodes.update(promoId, {
      active: false,
    });
    return true;
  } catch (err) {
    console.error('Error deactivating Stripe promotion code:', err);
    return false;
  }
};

/**
 * Deletes a Stripe Coupon (this also deactivates associated promotion codes)
 */
export const deleteStripeCoupon = async (region, couponId) => {
  const stripeClient = createStripeClient(region);

  try {
    await stripeClient.coupons.del(couponId);
    return true;
  } catch (err) {
    console.error('Error deleting Stripe coupon:', err);
    return false;
  }
};

/**
 * Creates a complete promocode in Stripe (coupon + promotion code)
 * @param {string} region - Region for stripe client
 * @param {string} productId - Stripe product ID to restrict coupon to
 * @param {object} promoData - Promocode data
 * @returns {object|null} - Promocode object or null if failed
 */
const createStripePromocodeComplete = async (region, productId, promoData) => {
  const { code, discountType, discount, useLimit, timeLimit, minAmount } = promoData;

  // Step 1: Create the coupon restricted to this product
  const couponId = await createStripeCoupon(region, productId, discountType, discount, minAmount);
  if (!couponId) {
    console.error('Failed to create Stripe coupon');
    return null;
  }

  // Step 2: Create the promotion code
  const promotionCode = await createStripePromotionCode(
    region,
    couponId,
    code,
    useLimit,
    timeLimit
  );

  if (!promotionCode) {
    // If promotion code creation fails, clean up the coupon
    await deleteStripeCoupon(region, couponId);
    console.error('Failed to create Stripe promotion code');
    return null;
  }

  // Step 3: Return the complete promocode object
  return {
    id: promotionCode.id, // Stripe promotion code ID
    couponId: couponId, // Stripe coupon ID
    code: promotionCode.code, // The actual code string
    discountType,
    discount,
    useLimit: useLimit || undefined,
    timeLimit: timeLimit ? new Date(timeLimit) : undefined,
    minAmount: minAmount || undefined,
    active: true,
  };
};

/**
 * Finds a promocode by ID in the array
 */
const findPromocodeById = (promoCodes, promoId) => {
  if (!promoCodes || promoCodes.length === 0) {
    return { index: -1, promocode: null };
  }

  const index = promoCodes.findIndex((promo) => promo.id === promoId);

  return {
    index,
    promocode: index !== -1 ? promoCodes[index] : null,
  };
};

/**
 * Process promoCodes for event creation - creates Stripe coupons and promotion codes
 * @param {string} region - Region for Stripe client
 * @param {string} productId - Stripe product ID to attach promocodes to
 * @param {Array} promoCodes - Array of promocode data
 * @returns {Array} - Array of processed promocodes with Stripe IDs
 */
export const processPromocodesForCreate = async (region, productId, promoCodes) => {
  if (!promoCodes || promoCodes.length === 0) {
    return [];
  }

  if (!productId) {
    console.error('Cannot create promocodes without a product ID');
    return [];
  }

  const processedPromocodes = [];

  for (const promoData of promoCodes) {
    // Validate promocode data
    const validationErrors = validatePromocodeData(
      promoData.code,
      promoData.discountType,
      promoData.discount
    );

    if (validationErrors.length > 0) {
      console.log(`Skipping invalid promocode: ${validationErrors[0]}`);
      continue;
    }

    // Check for duplicate codes in the current batch
    if (checkPromocodeDuplicate(processedPromocodes, promoData.code)) {
      console.log(`Skipping duplicate promocode: ${promoData.code}`);
      continue;
    }

    // Create promocode in Stripe, restricted to this product
    const stripePromocode = await createStripePromocodeComplete(region, productId, promoData);
    
    if (stripePromocode) {
      processedPromocodes.push(stripePromocode);
    } else {
      console.log(`Failed to create promocode in Stripe: ${promoData.code}`);
    }
  }

  return processedPromocodes;
};

/**
 * Process promoCodes for event updates - handles add, edit, and removal
 * @param {string} region - Region for Stripe client
 * @param {string} productId - Stripe product ID to attach new promocodes to
 * @param {Array} promoCodes - New/updated promocode data
 * @param {Array} existingPromocodes - Existing promocodes from database
 * @returns {Array} - Array of processed promocodes
 */
export const processPromocodesForUpdate = async (region, productId, promoCodes, existingPromocodes = []) => {
  if (promoCodes === null || promoCodes === undefined) {
    // If promoCodes is not provided, keep existing
    return existingPromocodes;
  }

  const processedPromocodes = [];
  const updatedPromoIds = new Set();

  for (const promoData of promoCodes) {
    // Handle editing existing promoCodes
    if (promoData.id && promoData.id.startsWith('promo_')) {
      // This is an existing Stripe promotion code
      const { promocode: existingPromo } = findPromocodeById(existingPromocodes, promoData.id);

      if (existingPromo) {
        updatedPromoIds.add(promoData.id);

        // Check if any meaningful changes were made
        const codeChanged = promoData.code && promoData.code.trim().toUpperCase() !== existingPromo.code;
        const discountTypeChanged = promoData.discountType && promoData.discountType !== existingPromo.discountType;
        const discountChanged = promoData.discount !== undefined && promoData.discount !== existingPromo.discount;
        const minAmountChanged = promoData.minAmount !== undefined && promoData.minAmount !== existingPromo.minAmount;
        const useLimitChanged = promoData.useLimit !== undefined && promoData.useLimit !== existingPromo.useLimit;
        const timeLimitChanged = promoData.timeLimit !== undefined && 
          new Date(promoData.timeLimit).getTime() !== new Date(existingPromo.timeLimit).getTime();

        if (codeChanged || discountTypeChanged || discountChanged || minAmountChanged || useLimitChanged || timeLimitChanged) {
          // Check for duplicate codes if code is being changed
          if (codeChanged) {
            if (checkPromocodeDuplicate(processedPromocodes, promoData.code, promoData.id)) {
              console.log(`Skipping duplicate promocode: ${promoData.code}`);
              processedPromocodes.push(existingPromo);
              continue;
            }
          }

          // Validate the update
          const validationErrors = validatePromocodeData(
            promoData.code || existingPromo.code,
            promoData.discountType !== undefined ? promoData.discountType : existingPromo.discountType,
            promoData.discount !== undefined ? promoData.discount : existingPromo.discount
          );

          if (validationErrors.length > 0) {
            console.log(`Skipping invalid promocode update: ${validationErrors[0]}`);
            processedPromocodes.push(existingPromo);
            continue;
          }

          // Need to create new coupon and promotion code if discount changed
          if (discountTypeChanged || discountChanged || minAmountChanged) {
            // Deactivate old promotion code
            await deactivateStripePromotionCode(region, existingPromo.id);
            
            // Create new promocode in Stripe
            const newPromoData = {
              code: promoData.code || existingPromo.code,
              discountType: promoData.discountType !== undefined ? promoData.discountType : existingPromo.discountType,
              discount: promoData.discount !== undefined ? promoData.discount : existingPromo.discount,
              useLimit: promoData.useLimit !== undefined ? promoData.useLimit : existingPromo.useLimit,
              timeLimit: promoData.timeLimit !== undefined ? promoData.timeLimit : existingPromo.timeLimit,
              minAmount: promoData.minAmount !== undefined ? promoData.minAmount : existingPromo.minAmount,
            };

            const updatedPromo = await createStripePromocodeComplete(region, productId, newPromoData);
            
            if (updatedPromo) {
              processedPromocodes.push(updatedPromo);
              // Clean up old coupon
              await deleteStripeCoupon(region, existingPromo.couponId);
            } else {
              console.log(`Failed to update promocode in Stripe: ${existingPromo.code}`);
              processedPromocodes.push(existingPromo);
            }
          } else {
            // Only code, useLimit, or timeLimit changed - need to create new promotion code
            const newCouponId = existingPromo.couponId;
            const newCode = promoData.code || existingPromo.code;
            const newUseLimit = promoData.useLimit !== undefined ? promoData.useLimit : existingPromo.useLimit;
            const newTimeLimit = promoData.timeLimit !== undefined ? promoData.timeLimit : existingPromo.timeLimit;

            const updatedPromotionCode = await updateStripePromotionCode(
              region,
              existingPromo.id,
              newCode,
              newCouponId,
              newUseLimit,
              newTimeLimit
            );

            if (updatedPromotionCode) {
              processedPromocodes.push({
                ...existingPromo,
                id: updatedPromotionCode.id,
                code: updatedPromotionCode.code,
                useLimit: newUseLimit,
                timeLimit: newTimeLimit ? new Date(newTimeLimit) : undefined,
              });
            } else {
              console.log(`Failed to update promotion code in Stripe: ${existingPromo.code}`);
              processedPromocodes.push(existingPromo);
            }
          }
        } else {
          // No changes, keep existing
          processedPromocodes.push(existingPromo);
        }
      }
    } else {
      // Handle adding new promoCodes
      const validationErrors = validatePromocodeData(
        promoData.code,
        promoData.discountType,
        promoData.discount
      );

      if (validationErrors.length > 0) {
        console.log(`Skipping invalid promocode: ${validationErrors[0]}`);
        continue;
      }

      // Check for duplicate codes
      if (checkPromocodeDuplicate(processedPromocodes, promoData.code)) {
        console.log(`Skipping duplicate promocode: ${promoData.code}`);
        continue;
      }

      // Create new promocode in Stripe, restricted to this product
      const newPromo = await createStripePromocodeComplete(region, productId, promoData);
      
      if (newPromo) {
        processedPromocodes.push(newPromo);
      } else {
        console.log(`Failed to create new promocode in Stripe: ${promoData.code}`);
      }
    }
  }

  // Deactivate any existing promocodes that weren't in the update
  for (const existingPromo of existingPromocodes) {
    if (!updatedPromoIds.has(existingPromo.id) && existingPromo.active !== false) {
      await deactivateStripePromotionCode(region, existingPromo.id);
    }
  }

  return processedPromocodes;
};

