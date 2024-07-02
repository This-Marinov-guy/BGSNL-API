import mongoose from "mongoose";
import Event from "../models/Event.js";
import HttpError from "../models/Http-error.js";
import moment from 'moment'
import { eventToSpreadsheet } from "../util/functions/searchInDatabase.js";
import uploadToCloudinary from "../util/functions/cloudinary.js";

const fetchEvent = async (req, res, next) => {
    const eventId = req.params.eventId;

    let event;
    try {
        event = await Event.findById(eventId)
    } catch (err) {
        return next(new HttpError("Fetching events failed", 500));
    }

    res.status(200).json({
        event: event.toObject({ getters: true }),
    });
}

const fetchEvents = async (req, res, next) => {
    const region = req.query.region;

    let events;
    try {
        if (region) {
            //remove hidden once we migrate
            events = await Event.find({ region, hidden: false })
        } else {
            events = await Event.find({ hidden: false })
        }
    } catch (err) {
        return next(new HttpError("Fetching events failed", 500));
    }

    res.status(200).json({
        events: events.map((event) => event.toObject({ getters: true })),
    });
}

const addEvent = async (req, res, next) => {
    const {
        memberOnly,
        hidden,
        freePass,
        discountPass,
        subEventDescription,
        subEventLinks,
        region,
        title,
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
        bgImage,
    } = req.body

    const extraInputsForm = JSON.parse(req.body.extraInputsForm);
    const date = moment(req.body.date, "ddd MMM DD YYYY HH:mm:ss [GMT]ZZ (z)").format("Do MMM YY");
    const time = moment(req.body.time, "ddd MMM DD YYYY HH:mm:ss [GMT]ZZ (z)").format("h:mm");

    //upload images
    try {
        if (await Event.findOne({
            title, region, date, time
        })) {
            const error = new HttpError("Event already exists", 422);
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
            subEventDescription,
            subEventLinks,
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
            poster,
            bgImage,
            bgImageExtra,
        })

        await event.save();

        // eventToSpreadsheet(societyEvent.id, eventName, region)

    } catch (err) {
        console.log(err);
        new HttpError("Operations failed! Please try again or contact support!", 500)
    }

    res.status(201).json({ status: true });
}

export { addEvent, fetchEvent, fetchEvents }