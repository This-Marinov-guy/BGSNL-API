import mongoose from "mongoose";
import Event from "../models/Event.js";
import HttpError from "../models/Http-error.js";
import { eventToSpreadsheet } from "../services/google-spreadsheets.js";
import { uploadToCloudinary, deleteFolder } from "../util/functions/cloudinary.js";
import { isEventTimerFinished, processExtraInputsForm } from "../util/functions/helpers.js";
import { areDatesEqual, dateConvertor } from "../util/functions/dateConvert.js";

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
        // check if it works
        // date: formatReactPrimeDate(date), 
        date,
        time,
        description,
        location,
        ticketTimer,
        ticketLimit,
        isSaleClosed,
        isFree,
        isMemberFree,
        entry,
        memberEntry,
        activeMemberEntry,
        entryIncluding,
        memberIncluding,
        including,
        ticketLink,
        priceId,
        memberPriceId,
        activeMemberPriceId,
        text,
        ticketColor,
        ticketQR,
        bgImage,
        bgImageSelection
    } = req.body

    const extraInputsForm = processExtraInputsForm(JSON.parse(req.body.extraInputsForm));
    const subEvent = JSON.parse(req.body.subEvent);

    //upload images
    try {
        if (await Event.findOne({
            title, region, date, time
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
            time,
            location,
            ticketTimer,
            ticketLimit,
            isSaleClosed,
            isFree,
            isMemberFree,
            entry,
            memberEntry,
            activeMemberEntry,
            entryIncluding,
            memberIncluding,
            including,
            ticketLink,
            priceId,
            memberPriceId,
            activeMemberPriceId,
            text,
            title,
            images,
            ticketImg,
            ticketColor,
            ticketQR: ticketQR === 'true',
            poster,
            bgImage,
            bgImageExtra,
            bgImageSelection,
            folder
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
        time,
        description,
        location,
        ticketTimer,
        ticketLimit,
        isSaleClosed,
        isFree,
        isMemberFree,
        entry,
        memberEntry,
        activeMemberEntry,
        entryIncluding,
        memberIncluding,
        including,
        ticketLink,
        ticketQR,
        priceId,
        memberPriceId,
        activeMemberPriceId,
        text,
        ticketColor,
        bgImage,
        bgImageSelection,
    } = req.body

    const extraInputsForm = processExtraInputsForm(JSON.parse(req.body.extraInputsForm));
    const subEvent = JSON.parse(req.body.subEvent);

    // const poster = await uploadToCloudinary(req.files['poster'][0], { folder, public_id: 'poster' })

    const ticketImg = await uploadToCloudinary(req.files['ticketImg'][0], {
            folder,
            public_id: 'ticket',
            width: 1500,
            height: 485,
            crop: 'fit',
            format: 'jpg'
        }) : '';

    // const bgImageExtra = req.files['bgImageExtra'] ? await uploadToCloudinary(req.files['bgImageExtra'][0], {
    //     folder,
    //     public_id: 'background',
    //     width: 1200,
    //     crop: 'fit',
    //     format: 'jpg'
    // }) : '';

    let images = [poster];

    // if (req.files['images']) {
    //     req.files['images'].forEach(async (img) => {
    //         try {
    //             const link = await uploadToCloudinary(img, { folder })
    //             images.push(link);
    //         } catch (err) {
    //             console.log(err);
    //         }
    //     });
    // }

    // event.extraInputsForm = extraInputsForm;
    // event.subEvent = subEvent;

    // poster && (event.poster = poster);
     ticketImg && (event.ticketImg = ticketImg);
    // bgImageExtra && (event.bgImageExtra = bgImageExtra);
    // bgImageSelection && (event.bgImageSelection = bgImageSelection);
    // images && images.length > 1 && (event.images = images);
    // memberOnly && (event.memberOnly = memberOnly);
    // hidden && (event.hidden = hidden);
    // freePass && (event.freePass = freePass);
    // discountPass && (event.discountPass = discountPass);
    // region && (event.region = region);
    // title && (event.title = title);
    // (date && areDatesEqual(event.date, date)) && (event.correctedDate = date);
    // (time && event.time !== time) && (event.correctedTime = time);
    // description && (event.description = description);
    // location && (event.location = location);
    // ticketTimer && (event.ticketTimer = ticketTimer);
    // ticketLimit && (event.ticketLimit = ticketLimit);
    // isSaleClosed && (event.isSaleClosed = isSaleClosed);
    // isFree && (event.isFree = isFree);
    // isMemberFree && (event.isMemberFree = isMemberFree);
    // entry && (event.entry = entry);
    // memberEntry && (event.memberEntry = memberEntry);
    // activeMemberEntry && (event.activeMemberEntry = activeMemberEntry);
    // entryIncluding && (event.entryIncluding = entryIncluding);
    // memberIncluding && (event.memberIncluding = memberIncluding);
    // including && (event.including = including);
    // ticketLink && (event.ticketLink = ticketLink);
    // priceId && (event.priceId = priceId);
    // memberPriceId && (event.memberPriceId = memberPriceId);
    // activeMemberPriceId && (event.activeMemberPriceId = activeMemberPriceId);
    // text && (event.text = text);
    // ticketColor && (event.ticketColor = ticketColor);
    // event.ticketQR = ticketQR === 'true',
    // bgImage && (event.bgImage = bgImage);

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

    try {
        await event.delete();
    } catch (err) {
        console.log(err);
        return new HttpError("Operations failed! Please try again or contact support!", 500)
    }

    await deleteFolder(folder);
    res.status(200).json({ status: true });
}

export { addEvent, editEvent, deleteEvent, fetchEvent, fetchEvents }
