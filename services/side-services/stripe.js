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
        await stripeClient.products.del(productId);
    } catch (err) {
        console.log(err);
        return false
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

