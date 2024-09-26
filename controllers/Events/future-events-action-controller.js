import Event from "../../models/Event.js";
import HttpError from "../../models/Http-error.js";
import { uploadToCloudinary, deleteFolder } from "../../util/functions/cloudinary.js";
import { isEventTimerFinished, processExtraInputsForm, replaceSpecialSymbolsWithSpaces } from "../../util/functions/helpers.js";
import { MOMENT_DATE_TIME_YEAR, areDatesEqual } from "../../util/functions/dateConvert.js";
import moment from "moment/moment.js";
import { deleteProduct } from "../../services/side-services/stripe.js";
import { createEventProductWithPrice, updateEventPrices } from "../../services/main-services/event-action-service.js";
import { eventToSpreadsheet } from "../../services/side-services/google-spreadsheets.js";

export const fetchFullDataEvent = async (req, res, next) => {
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

    event = event.toObject({ getters: true });

    res.status(200).json({
        event,
        status
    });
}

export const fetchFullDataEventsList = async (req, res, next) => {
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

    events = events.map((event) => event.toObject({ getters: true }))

    res.status(200).json({ events });
}

export const addEvent = async (req, res, next) => {
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

    let event;

    //upload images
    if (await Event.findOne({
        title, region, date
    })) {
        const error = new HttpError("Event already exists - find it in the dashboard and edit it!", 422);
        return next(error);
    }

    const folder = `${region}_${replaceSpecialSymbolsWithSpaces(title)}_${date}`;

    if (!req.files['poster'] || !req.files['ticketImg']) {
        const error = new HttpError("We lack poster or/and ticket", 422);
        return next(error);
    }

    const poster = await uploadToCloudinary(req.files['poster'][0], {
        folder,
        public_id: 'poster',
        width: 1000,
        height: 1000,
        crop: 'fit',
        format: 'jpg'
    });

    const ticketImg = await uploadToCloudinary(req.files['ticketImg'][0], {
        folder,
        public_id: 'ticket',
        width: 1500,
        height: 485,
        crop: 'fit',
        format: 'jpg'
    });

    const bgImageExtra = req.files['bgImageExtra'] ? await uploadToCloudinary(req.files['bgImageExtra'][0], {
        folder,
        public_id: 'background',
        width: 1200,
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
    let product = null;

    if (isFree !== 'true') {
        product = await createEventProductWithPrice({
            name: title,
            image: poster,
            region: region,
            date: date
        }, guestPrice, memberPrice, activeMemberPrice);

        if (!product.id) {
            return next(new HttpError('Stripe Product could not be created, please try again!', 500));
        }
    }

    const sheetName = `${title}|${moment(date).format(MOMENT_DATE_TIME_YEAR)}`

    //create event 
    event = new Event({
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
    });

    try {
        await event.save();
    } catch (err) {
        console.log(err);
        return next(new HttpError("Operations failed! Please try again or contact support!", 500));
    }

    try {
        await eventToSpreadsheet(event.id);
    } catch { }

    res.status(201).json({ status: true, event });
}

export const editEvent = async (req, res, next) => {
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

    const poster = req.files['poster'] ? await uploadToCloudinary(req.files['poster'][0], {
        folder,
        public_id: 'poster',
        width: 1000,
        height: 1000,
        crop: 'fit',
        format: 'jpg'
    }) : null;

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

    event.extraInputsForm = extraInputsForm;
    event.subEvent = subEvent;

    poster && (event.poster = poster);
    ticketImg && (event.ticketImg = ticketImg);
    bgImageExtra && (event.bgImageExtra = bgImageExtra);
    images && images.length > 1 && (event.images = images);

    (date && !areDatesEqual(event.date, date)) && (event.correctedDate = date);

    try {
        // if no product and prices are passed, we create a product. If we have product we update it
        if (!event.isFree && !(event.product && event.product.id) && (guestPrice || memberPrice || activeMemberPrice)) {
            event.product = await createEventProductWithPrice({
                name: event.title,
                image: event.poster,
                region: event.region,
                date: event.date
            }, guestPrice, memberPrice, activeMemberPrice);
        } else if (!event.isFree && event?.product && event.product.id) {
            event.product = await updateEventPrices(event.product, guestPrice, memberPrice, activeMemberPrice);
        }

    } catch (err) {
        console.log(err);
        return next(new HttpError("Price update failed!", 500));
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
    event.ticketQR = ticketQR === 'true';
    event.ticketName = ticketName === 'true';
    event.bgImage = bgImage;

    try {
        await event.save();
    } catch (err) {
        console.log(err);
        return next(new HttpError("Operations failed! Please try again or contact support!", 500));
    }

    try {
        // await eventToSpreadsheet(event.id);
    } catch { }

    res.status(200).json({ status: true, event });
}

export const deleteEvent = async (req, res, next) => {
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
    res.status(200).json({ status: true, eventId });
}
