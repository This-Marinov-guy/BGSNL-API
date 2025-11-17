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

// Promocode validation and management functions
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

const generatePromocodeId = () => {
  return `promo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

const createPromocodeObject = (data) => {
  const { code, discountType, discount, useLimit, timeLimit, minAmount } =
    data;

  const promocode = {
    id: generatePromocodeId(),
    code: code.trim().toUpperCase(),
    discountType,
    discount,
    redeemed: 0,
  };

  if (useLimit !== undefined && useLimit !== null) {
    promocode.useLimit = useLimit;
  }

  if (timeLimit) {
    promocode.timeLimit = new Date(timeLimit);
  }

  if (minAmount !== undefined && minAmount !== null) {
    promocode.minAmount = minAmount;
  }

  return promocode;
};

const updatePromocodeObject = (existingPromo, updates) => {
  const { code, discountType, discount, useLimit, timeLimit, minAmount } =
    updates;

  if (code !== undefined) {
    existingPromo.code = code.trim().toUpperCase();
  }

  if (discountType !== undefined) {
    existingPromo.discountType = discountType;
  }

  if (discount !== undefined && discount !== null) {
    existingPromo.discount = discount;
  }

  if (useLimit !== undefined) {
    if (useLimit === null || useLimit === "") {
      existingPromo.useLimit = undefined;
    } else {
      existingPromo.useLimit = useLimit;
    }
  }

  if (timeLimit !== undefined) {
    if (timeLimit === null || timeLimit === "") {
      existingPromo.timeLimit = undefined;
    } else {
      existingPromo.timeLimit = new Date(timeLimit);
    }
  }

  if (minAmount !== undefined) {
    if (minAmount === null || minAmount === "") {
      existingPromo.minAmount = undefined;
    } else {
      existingPromo.minAmount = minAmount;
    }
  }

  return existingPromo;
};

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

const validatePromocodeUpdate = (
  discountType,
  discount,
  existingDiscountType
) => {
  const errors = [];

  if (discountType !== undefined && discountType !== 1 && discountType !== 2) {
    errors.push("discountType must be 1 (fixed amount) or 2 (percentage)");
  }

  if (discount !== undefined && discount !== null) {
    if (discount < 0) {
      errors.push("Discount cannot be negative");
    }

    const finalDiscountType = discountType || existingDiscountType;
    if (finalDiscountType === 2 && discount > 100) {
      errors.push("Percentage discount cannot exceed 100%");
    }
  }

  return errors;
};

// Process promoCodes for event creation
export const processPromocodesForCreate = (promoCodes) => {
  if (!promoCodes || promoCodes.length === 0) {
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

    // Check for duplicate codes
    if (checkPromocodeDuplicate(processedPromocodes, promoData.code)) {
      console.log(`Skipping duplicate promocode: ${promoData.code}`);
      continue;
    }

    // Create promocode object
    const promocode = createPromocodeObject(promoData);
    processedPromocodes.push(promocode);
  }

  return processedPromocodes;
};

// Process promoCodes for event updates (handles both add and edit)
export const processPromocodesForUpdate = (promoCodes, existingPromocodes = []) => {
  if (promoCodes === null || promoCodes === undefined) {
    // If promoCodes is not provided, keep existing
    return existingPromocodes;
  }

  const processedPromocodes = [];

  for (const promoData of promoCodes) {
    // Handle editing existing promoCodes
    if (promoData.id) {
      const { index: promoIndex, promocode: existingPromo } =
        findPromocodeById(existingPromocodes, promoData.id);

      if (promoIndex !== -1) {
        // If code is being changed, check for duplicates
        if (
          promoData.code &&
          promoData.code.trim().toUpperCase() !== existingPromo.code
        ) {
          if (
            checkPromocodeDuplicate(
              processedPromocodes,
              promoData.code,
              promoData.id
            )
          ) {
            console.log(`Skipping duplicate promocode: ${promoData.code}`);
            continue;
          }
        }

        // Validate update data
        const validationErrors = validatePromocodeUpdate(
          promoData.discountType,
          promoData.discount,
          existingPromo.discountType
        );

        if (validationErrors.length > 0) {
          console.log(
            `Skipping invalid promocode update: ${validationErrors[0]}`
          );
          // Keep the existing promocode
          processedPromocodes.push(existingPromo);
          continue;
        }

        // Update promocode
        const updatedPromo = updatePromocodeObject(existingPromo, promoData);
        processedPromocodes.push(updatedPromo);
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

      // Create new promocode
      const newPromo = createPromocodeObject(promoData);
      processedPromocodes.push(newPromo);
    }
  }

  return processedPromocodes;
};

