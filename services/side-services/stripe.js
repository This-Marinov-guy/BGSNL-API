import dotenv from "dotenv";
dotenv.config();
import Stripe from "stripe";
import { capitalizeFirstLetter } from '../../util/functions/helpers.js'
import moment from "moment";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2022-08-01",
});

export const stripeProductDescription = (region, title, date) => {
    if (!date || !title || !region) {
        return '';
    }

    return `Event Ticket for ${capitalizeFirstLetter(region)}'s ${title} on ${moment(date).format(MOMENT_DATE_YEAR)}`
}

export const addProduct = async (data, priceData = []) => {
    let product;
    const properties = {
        name: data['name'],
        images: [data['image']],
        description: stripeProductDescription(data['region'], data['title'], data['date'])
    }

    try {
        product = await stripe.products.create(properties);

        // priceData.forEach(async (amount) => {
        //     const priceId = await addPrice(product['id'], amount);

        //     if (priceId) {

        //     }
        // });
    } catch (err) {
        console.log(err);
        return false
    }

    return product['id'];
}

export const editProduct = async (productId, data) => {
    try {
        await stripe.products.update(
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

export const deleteProduct = async (productId) => {
    if (!productId) {
        return false;
    }

    try {
        await stripe.products.del(productId);
    } catch (err) {
        console.log(err);
        return false
    }

    return true;
}

export const addPrice = async (productId, amount = 0) => {
    if (!amount) {
        return false;
    }

    let price;

    try {
        price = await stripe.prices.create({
            currency: 'eur',
            unit_amount: amount * 100,
            product: productId,
            // nickname: data['devDescription'] ?? '', 
        });
    } catch (err) {
        console.log(err);
        return false
    }

    return price['id'];
}

export const editPrice = async (priceId, data) => {
    try {
        await stripe.prices.update(
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

