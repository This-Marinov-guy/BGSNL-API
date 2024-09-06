import mongoose from "mongoose";
import Event from "../models/Event.js";
import HttpError from "../models/Http-error.js";
import { eventToSpreadsheet } from "../services/side-services/google-spreadsheets.js";
import { uploadToCloudinary, deleteFolder } from "../util/functions/cloudinary.js";
import { isEventTimerFinished, processExtraInputsForm } from "../util/functions/helpers.js";
import { MOMENT_DATE_TIME_YEAR, areDatesEqual, dateConvertor } from "../util/functions/dateConvert.js";
import moment from "moment/moment.js";
import { addPrice, addProduct, deleteProduct } from "../services/side-services/stripe.js";
import { createEventProductWithPrice, updateEventPrices } from "../services/main-services/event-action-service.js";

const fetchEvent = async (req, res, next) => {
    const eventId = req.params.eventId;

    let event;
    try {
        event = await Event.findById(eventId)
    } catch (err) {
        return next(new HttpError("Fetching events failed", 500));
    }

    if (!event) {
        return next(new HttpError("No such event", 404));
    }

    let status = true;

    const ticketsRemaining = event.ticketLimit - event.guestList.length;
    const expired = isEventTimerFinished(event.ticketTimer);

    if (ticketsRemaining <= 0 || expired) {
        status = false;
    }

    res.status(200).json({
        event: event.toObject({ getters: true }),
        status
    });
}

const fetchEvents = async (req, res, next) => {
    const region = req.query.region;

    let events;

    try {
        if (region) {
            events = await Event.find({ region });
        } else {
            events = await Event.find();
        }

    } catch (err) {
        return next(new HttpError("Fetching events failed", 500));
    }

    res.status(200).json({ events: events.map((event) => event.toObject({ getters: true })) });
}

const addEvent = async (req, res, next) => {
    const {
        memberOnly,
        hidden,
        freePass,
        discountPass,
        region,
        title,
        date,
        description,
        location,
        ticketTimer,
        ticketLimit,
        isSaleClosed,
        isFree,
        isMemberFree,
        guestPrice,
        memberPrice,
        activeMemberPrice,
        entryIncluding,
        memberIncluding,
        including,
        ticketLink,
        text,
        ticketColor,
        ticketQR,
        ticketName,
        bgImage,
        bgImageSelection
    } = req.body

    const extraInputsForm = processExtraInputsForm(JSON.parse(req.body.extraInputsForm));
    const subEvent = JSON.parse(req.body.subEvent);

    //upload images
    try {
        if (await Event.findOne({
            title, region, date
        })) {
            const error = new HttpError("Event already exists - find it in the dashboard and edit it!", 422);
            return next(error);
        }

        const folder = `${region}_${title}_${date}`

        if (!req.files['poster'] || !req.files['ticketImg']) {
            const error = new HttpError("We lack poster or/and ticket", 422);
            return next(error);
        }

        const poster = await uploadToCloudinary(req.files['poster'][0], { folder, public_id: 'poster' });
        const ticketImg = await uploadToCloudinary(req.files['ticketImg'][0], {
            folder,
            public_id: 'ticket',
            width: 1500,
            height: 485,
            crop: 'fit',
            format: 'jpg'
        })
        const bgImageExtra = req.files['bgImageExtra'] ? await uploadToCloudinary(req.files['bgImageExtra'][0], {
            folder,
            public_id: 'background',
            width: 800,
            crop: 'fit',
            format: 'jpg'
        }) : '';

        let images = [poster];
        if (req.files['images']) {
            req.files['images'].forEach(async (img) => {
                try {
                    const link = await uploadToCloudinary(img, { folder })
                    images.push(link);
                } catch (err) {
                    console.log(err);
                }

            });
        }

        //create product
        const product = await createEventProductWithPrice({
            name: title,
            images: poster
        }, guestPrice, memberPrice, activeMemberPrice);

        if (!product) {
            return next(new HttpError('Stripe Product could not be created, please try again!', 500));
        }

        const sheetName = `${title}|${moment(date).format(MOMENT_DATE_TIME_YEAR)}`

        //create event 
        const event = new Event({
            memberOnly,
            hidden,
            extraInputsForm,
            freePass,
            discountPass,
            subEvent,
            region,
            title,
            description,
            date,
            location,
            ticketTimer,
            ticketLimit,
            isSaleClosed,
            isFree,
            isMemberFree,
            entryIncluding,
            memberIncluding,
            including,
            ticketLink,
            text,
            title,
            images,
            ticketImg,
            ticketColor,
            ticketQR: ticketQR === 'true',
            ticketName: ticketName === 'true',
            poster,
            bgImage,
            bgImageExtra,
            bgImageSelection,
            folder,
            sheetName,
            product
        })

        await event.save();

        // await eventToSpreadsheet(societyEvent.id)

    } catch (err) {
        console.log(err);
        return next(new HttpError("Operations failed! Please try again or contact support!", 500));
    }

    res.status(201).json({ status: true });
}

const editEvent = async (req, res, next) => {
    const eventId = req.params.eventId;

    let event;
    try {
        event = await Event.findById(eventId)
    } catch (err) {
        return next(new HttpError("Fetching events failed", 500));
    }

    if (!event) {
        return next(new HttpError("No such event", 404));
    }

    const folder = event.folder ?? 'spare';

    const {
        memberOnly,
        hidden,
        freePass,
        discountPass,
        region,
        title,
        date,
        description,
        location,
        ticketTimer,
        ticketLimit,
        isSaleClosed,
        isFree,
        isMemberFree,
        guestPrice,
        memberPrice,
        activeMemberPrice,
        entryIncluding,
        memberIncluding,
        including,
        ticketLink,
        ticketQR,
        ticketName,
        text,
        ticketColor,
        bgImage,
        bgImageSelection,
    } = req.body

    const extraInputsForm = processExtraInputsForm(JSON.parse(req.body.extraInputsForm));
    const subEvent = JSON.parse(req.body.subEvent);

    const poster = req.files['poster'] ? await uploadToCloudinary(req.files['poster'][0], { folder, public_id: 'poster' }) : null;

    const ticketImg = req.files['ticketImg'] ? await uploadToCloudinary(req.files['ticketImg'][0], {
        folder,
        public_id: 'ticket',
        width: 1500,
        height: 485,
        crop: 'fit',
        format: 'jpg'
    }) : null;

    const bgImageExtra = req.files['bgImageExtra'] ? await uploadToCloudinary(req.files['bgImageExtra'][0], {
        folder,
        public_id: 'background',
        width: 1200,
        crop: 'fit',
        format: 'jpg'
    }) : '';

    let images = [];

    if (req.files['images']) {
        req.files['images'].forEach(async (img) => {
            try {
                const link = await uploadToCloudinary(img, { folder })
                images.push(link);
            } catch (err) {
                console.log(err);
            }
        });
    }

    event.extraInputsForm = extraInputsForm;
    event.subEvent = subEvent;

    poster && (event.poster = poster);
    ticketImg && (event.ticketImg = ticketImg);
    bgImageExtra && (event.bgImageExtra = bgImageExtra);
    images && images.length > 1 && (event.images = images);

    (date && areDatesEqual(event.date, date)) && (event.correctedDate = date);

    // if no product and prices are passed, we create a product. If we have product we update it
    if (!event.hasOwnProperty('product') && (guestPrice || memberPrice || activeMemberPrice)) {
        event.product = await updateEventPrices(event.product, guestPrice, memberPrice, activeMemberPrice);
    } else if (event.hasOwnProperty('product')) {
        event.product = await updateEventPrices(event.product, guestPrice, memberPrice, activeMemberPrice);
    }

    event.bgImageSelection = bgImageSelection;
    event.memberOnly = memberOnly;
    event.hidden = hidden;
    event.freePass = freePass;
    event.discountPass = discountPass;
    event.region = region;
    event.title = title;
    event.description = description;
    event.location = location;
    event.ticketTimer = ticketTimer;
    event.ticketLimit = ticketLimit;
    event.isSaleClosed = isSaleClosed;
    event.isFree = isFree;
    event.isMemberFree = isMemberFree;
    event.entryIncluding = entryIncluding;
    event.memberIncluding = memberIncluding;
    event.including = including;
    event.ticketLink = ticketLink;
    event.text = text;
    event.ticketColor = ticketColor;
    event.ticketQR = ticketQR === 'true',
        event.ticketName = ticketName === 'true',
        event.bgImage = bgImage;

    try {
        await event.save();
        // await eventToSpreadsheet(societyEvent.id)

    } catch (err) {
        console.log(err);
        return next(new HttpError("Operations failed! Please try again or contact support!", 500));
    }

    res.status(200).json({ status: true });
}

const deleteEvent = async (req, res, next) => {
    const eventId = req.params.eventId;

    let event;
    try {
        event = await Event.findById(eventId)
    } catch (err) {
        return next(new HttpError("Fetching events failed", 500));
    }

    if (!event) {
        return next(new HttpError("No such event", 404));
    }

    const folder = event.folder ?? '';
    const productId = event.product.id ?? '';

    try {
        await event.delete();
    } catch (err) {
        console.log(err);
        return new HttpError("Operations failed! Please try again or contact support!", 500)
    }

    await deleteProduct(productId);
    await deleteFolder(folder);
    res.status(200).json({ status: true });
}

export { addEvent, editEvent, deleteEvent, fetchEvent, fetchEvents }
