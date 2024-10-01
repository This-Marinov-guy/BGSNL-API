import { addPrice, addProduct } from "../side-services/stripe.js";

export const createEventProductWithPrice = async (data, guestPrice = 0, memberPrice = 0, activeMemberPrice = 0) => {
    const productId = await addProduct({
        name: data['name'],
        image: data['image'],
        region: data['region'],
        date: data['date'],
    });

    if (!productId) {
        return false;
    }

    const guestPriceId = await addPrice(data['region'], productId, guestPrice, 'guest');
    const memberPriceId = await addPrice(data['region'], productId, memberPrice, 'member');
    const activeMemberPriceId = await addPrice(data['region'], productId, activeMemberPrice, 'active member');

    const product = {
        id: productId,
    }

    if (guestPriceId) {
        product.guest = {
            price: guestPrice,
            priceId: guestPriceId
        }
    }

    if (memberPriceId) {
        product.member = {
            price: memberPrice,
            priceId: memberPriceId
        }
    }

    if (activeMemberPriceId) {
        product.activeMember = {
            price: activeMemberPrice,
            priceId: activeMemberPriceId
        }
    }

    // no prices
    if (Object.keys(product).length === 1){
        return false;
    }

    return product
}


export const updateEventPrices = async (region, product, guestPrice = 0, memberPrice = 0, activeMemberPrice = 0) => {
    if (guestPrice && (!product.guest || product.guest?.price !== guestPrice)) {
        const guestPriceId = await addPrice(region, product.id, guestPrice, 'guest');

        if (guestPriceId) {
            product.guest = {
                price: guestPrice,
                priceId: guestPriceId
            }
        }
    }

    if (memberPrice && (!product.member || product.member?.price !== memberPrice)) {
        const memberPriceId = await addPrice(region, product.id, memberPrice, 'member');

        if (memberPriceId) {
            product.member = {
                price: memberPrice,
                priceId: memberPriceId
            }
        }
    }

    if (activeMemberPrice && (!product.activeMember || product.activeMember?.price !== activeMemberPrice)) {
        const activeMemberPriceId = await addPrice(region, product.id, activeMemberPrice, 'active member');

        if (activeMemberPriceId) {
            product.activeMember = {
                price: activeMemberPrice,
                priceId: activeMemberPriceId
            }
        }
    }

    return product;
}