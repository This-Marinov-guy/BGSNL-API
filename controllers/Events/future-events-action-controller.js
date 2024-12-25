import Event from "../../models/Event.js";
import HttpError from "../../models/Http-error.js";
import {
  uploadToCloudinary,
  deleteFolder,
} from "../../util/functions/cloudinary.js";
import {
  isEventTimerFinished,
  parseStingData,
  processExtraInputsForm,
  removeModelProperties,
  replaceSpecialSymbolsWithSpaces,
} from "../../util/functions/helpers.js";
import {
  MOMENT_DATE_TIME_YEAR,
  MOMENT_DATE_TIME,
  areDatesEqual,
} from "../../util/functions/dateConvert.js";
import moment from "moment/moment.js";
import {
  addPrice,
  deleteProduct,
} from "../../services/side-services/stripe.js";
import {
  checkDiscountsOnEvents,
  createEventProductWithPrice,
  updateEventPrices,
} from "../../services/main-services/event-action-service.js";
import { eventToSpreadsheet } from "../../services/side-services/google-spreadsheets.js";
import { getFingerprintLite } from "../../services/main-services/user-service.js";
import { 
  addEventToGoogleCalendar, 
  insertOrUpdateEvent, 
  deleteCalendarEvent 
} from "../../services/side-services/google-calendar.js";

export const fetchFullDataEvent = async (req, res, next) => {
  const eventId = req.params.eventId;

  let event;
  try {
    event = await Event.findById(eventId);
  } catch (err) {
    return res.status(200).json({
      status: false,
    });
  }

  if (!event) {
    return res.status(200).json({
      status: false,
    });
  }

  let status = true;

  const ticketsRemaining = event.ticketLimit - event.guestList.length;
  const expired = isEventTimerFinished(event.ticketTimer);

  if (ticketsRemaining <= 0 || expired) {
    status = false;
  }

  event = checkDiscountsOnEvents(event);
  // TODO: remove early, lateBird and add them to a new
  event = removeModelProperties(event, ["guestList"]);

  res.status(200).json({
    event,
    status,
  });
};

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

  // TODO: remove early, lateBird and add them to a new
  events = events.map((event) => removeModelProperties(event, ["guestList"]));

  res.status(200).json({ events });
};

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
    bgImageSelection,
  } = req.body;

  const extraInputsForm = processExtraInputsForm(
    parseStingData(req.body.extraInputsForm)
  );

  const earlyBird = JSON.parse(req.body.earlyBird);
  const lateBird = JSON.parse(req.body.lateBird);
  const guestPromotion = JSON.parse(req.body.guestPromotion);
  const memberPromotion = JSON.parse(req.body.memberPromotion);

  const subEvent = JSON.parse(req.body.subEvent);

  let event;

  //upload images
  if (
    await Event.findOne({
      title,
      region,
      date,
    })
  ) {
    const error = new HttpError(
      "Event already exists - find it in the dashboard and edit it!",
      422
    );
    return next(error);
  }

  const folder = `${region}_${replaceSpecialSymbolsWithSpaces(title)}_${moment(
    date
  ).format(MOMENT_DATE_TIME)}`;

  if (!req.files["poster"] || !req.files["ticketImg"]) {
    const error = new HttpError("We lack poster or/and ticket", 422);
    return next(error);
  }

  const poster = await uploadToCloudinary(req.files["poster"][0], {
    folder,
    public_id: "poster",
    width: 800,
    height: 800,
    crop: "fit",
    format: "jpg",
  });

  const ticketImg = await uploadToCloudinary(req.files["ticketImg"][0], {
    folder,
    public_id: "ticket",
    width: 1500,
    height: 485,
    crop: "fit",
    format: "jpg",
  });

  const bgImageExtra = req.files["bgImageExtra"]
    ? await uploadToCloudinary(req.files["bgImageExtra"][0], {
        folder,
        public_id: "background",
        width: 1200,
        crop: "fit",
        format: "jpg",
      })
    : "";

  let images = [];

  if (req.files && req.files["images"] && req.files["images"]?.length > 0) {
    const uploadPromises = req.files["images"].map(async (img) => {
      try {
        const link = await uploadToCloudinary(img, {
          folder,
          public_id: img.originalname,
          width: 800,
          height: 800,
          crop: "fit",
          format: "jpg",
        });
        return link;
      } catch (err) {
        console.error(`Error uploading image ${img.originalname}:`, err);
        return null; // or handle the error as appropriate for your use case
      }
    });

    const uploadedImages = await Promise.all(uploadPromises);
    images = images.concat(uploadedImages.filter((link) => link !== null));
  }

  images.unshift(poster);

  //create product
  let product = null;

  if (isFree !== "true") {
    product = await createEventProductWithPrice(
      {
        name: title,
        image: poster,
        region: region,
        date: date,
      },
      guestPrice,
      memberPrice,
      activeMemberPrice
    );

    if (!product.id) {
      return next(
        new HttpError(
          "Stripe Product could not be created, please try again!",
          500
        )
      );
    }

    if (earlyBird.isEnabled) {
      try {
        earlyBird["priceId"] = await addPrice(
          region,
          product.id,
          earlyBird["price"],
          "early bird guest"
        );

        earlyBird["memberPriceId"] = await addPrice(
          region,
          product.id,
          earlyBird["memberPrice"],
          "early bird member"
        );
      } catch (err) {
        console.log(err.message);
      }
    }

    if (lateBird.isEnabled) {
      try {
        lateBird["priceId"] = await addPrice(
          region,
          product.id,
          lateBird["price"],
          "late bird guest"
        );

        lateBird["memberPriceId"] = await addPrice(
          region,
          product.id,
          lateBird["memberPrice"],
          "late bird member"
        );
      } catch (err) {
        console.log(err.message);
      }
    }

    if (guestPromotion.isEnabled) {
      const discountedPrice =
        Math.round(product.guest.price * (100 - guestPromotion.discount)) / 100;

      try {
        guestPromotion["priceId"] = await addPrice(
          region,
          product.id,
          discountedPrice,
          "guest promotion"
        );
      } catch (err) {
        console.log(err.message);
      }
    }

    if (memberPromotion.isEnabled) {
      const discountedPrice =
        Math.round(product.member.price * (100 - memberPromotion.discount)) /
        100;

      try {
        memberPromotion["priceId"] = await addPrice(
          region,
          product.id,
          discountedPrice,
          "member promotion"
        );
      } catch (err) {
        console.log(err.message);
      }
    }
  }

  const sheetName = `${title}|${moment(date).format(MOMENT_DATE_TIME_YEAR)}`;

  //create event
  event = new Event({
    lastUpdate: getFingerprintLite(req),
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
    images,
    ticketImg,
    ticketColor,
    ticketQR: ticketQR === "true",
    ticketName: ticketName === "true",
    poster,
    bgImage,
    bgImageExtra,
    bgImageSelection,
    folder,
    sheetName,
    product,
    promotion: {
      guest: guestPromotion,
      member: memberPromotion,
    },
    earlyBird,
    lateBird,
    googleEventId: "",
  });

  try {
    await event.save();
    await addEventToGoogleCalendar(event);
  } catch (err) {
    console.log(err);
    return next(
      new HttpError(
        "Operations failed! Please try again or contact support!",
        500
      )
    );
  }

  try {
    await eventToSpreadsheet(event.id);
  } catch {}

  event = event.toObject({ getters: true });

  res.status(201).json({ status: true, event });
};

export const editEvent = async (req, res, next) => {
  const eventId = req.params.eventId;

  let event;
  try {
    event = await Event.findById(eventId);
  } catch (err) {
    return next(new HttpError("Fetching events failed", 500));
  }

  if (!event) {
    return next(new HttpError("No such event", 404));
  }

  const folder = event.folder ?? "spare";

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
    googleEventId,
  } = req.body;

  const extraInputsForm = processExtraInputsForm(
    parseStingData(req.body.extraInputsForm)
  );

  const earlyBird = JSON.parse(req.body.earlyBird);
  const lateBird = JSON.parse(req.body.lateBird);
  const guestPromotion = JSON.parse(req.body.guestPromotion);
  const memberPromotion = JSON.parse(req.body.memberPromotion);
  const subEvent = JSON.parse(req.body.subEvent);

  const poster = req.files["poster"]
    ? await uploadToCloudinary(req.files["poster"][0], {
        folder,
        public_id: "poster",
        width: 1000,
        height: 1000,
        crop: "fit",
        format: "jpg",
      })
    : null;

  const ticketImg = req.files["ticketImg"]
    ? await uploadToCloudinary(req.files["ticketImg"][0], {
        folder,
        public_id: "ticket",
        width: 1500,
        height: 485,
        crop: "fit",
        format: "jpg",
      })
    : null;

  const bgImageExtra = req.files["bgImageExtra"]
    ? await uploadToCloudinary(req.files["bgImageExtra"][0], {
        folder,
        public_id: "background",
        width: 1200,
        crop: "fit",
        format: "jpg",
      })
    : "";

  let images = [];

  if (req.files && req.files["images"] && req.files["images"]?.length > 0) {
    const uploadPromises = req.files["images"].map(async (img) => {
      try {
        const link = await uploadToCloudinary(img, {
          folder,
          public_id: img.originalname,
          width: 800,
          height: 800,
          crop: "fit",
          format: "jpg",
        });
        return link;
      } catch (err) {
        console.error(`Error uploading image ${img.originalname}:`, err);
        return null; // or handle the error as appropriate for your use case
      }
    });

    const uploadedImages = await Promise.all(uploadPromises);
    images = images.concat(uploadedImages.filter((link) => link !== null));
  }

  images.unshift(poster || event.poster);

  event.lastUpdate = getFingerprintLite(req);
  event.extraInputsForm = extraInputsForm;
  event.subEvent = subEvent;

  poster && (event.poster = poster);
  ticketImg && (event.ticketImg = ticketImg);
  bgImageExtra && (event.bgImageExtra = bgImageExtra);

  date && !areDatesEqual(event.date, date) && (event.correctedDate = date);

  try {
    // if no product and prices are passed, we create a product. If we have product we update it
    if (
      isFree !== "true" &&
      !(event.product && event.product.id) &&
      !!(guestPrice || memberPrice || activeMemberPrice)
    ) {
      event.product = await createEventProductWithPrice(
        {
          name: event.title,
          image: event.poster,
          region: event.region,
          date: event.date,
        },
        guestPrice,
        memberPrice,
        activeMemberPrice
      );
    } else if (isFree !== "true" && !!event?.product && !!event.product?.id) {
      event.product = await updateEventPrices(
        event.region,
        event.product,
        guestPrice,
        memberPrice,
        activeMemberPrice
      );
    }
  } catch (err) {
    console.log(err);
    return next(new HttpError("Price update failed!", 500));
  }

  if (earlyBird.isEnabled && event?.product) {
    try {
      if (earlyBird["price"] != event?.earlyBird?.price) {
        earlyBird["priceId"] = await addPrice(
          region,
          event.product.id,
          earlyBird["price"],
          "early bird guest"
        );
      }

      if (earlyBird["memberPrice"] != event?.earlyBird?.memberPrice) {
        earlyBird["memberPriceId"] = await addPrice(
          region,
          event.product.id,
          earlyBird["memberPrice"],
          "early bird member"
        );
      }
    } catch (err) {
      console.log(err.message);
    }
  }

  if (lateBird.isEnabled && event?.product) {
    try {
      if (lateBird["price"] != event?.lateBird?.price) {
        lateBird["priceId"] = await addPrice(
          region,
          event.product.id,
          lateBird["price"],
          "late bird guest"
        );
      }

      if (lateBird["memberPrice"] != event?.lateBird?.memberPrice) {
        lateBird["memberPriceId"] = await addPrice(
          region,
          event.product.id,
          lateBird["memberPrice"],
          "late bird member"
        );
      }
    } catch (err) {
      console.log(err.message);
    }
  }

  if (
    guestPromotion.isEnabled &&
    event?.product &&
    guestPromotion.discount !== event?.promotion?.guest?.discount
  ) {
    const discountedPrice =
      Math.round(event.product.guest.price * (100 - guestPromotion.discount)) /
      100;

    try {
      guestPromotion["priceId"] = await addPrice(
        region,
        event.product.id,
        discountedPrice,
        "guest promotion"
      );
    } catch (err) {
      console.log(err.message);
    }
  }

  if (
    memberPromotion.isEnabled &&
    event?.product &&
    memberPromotion.discount !== event?.promotion?.member?.discount
  ) {
    const discountedPrice =
      Math.round(
        event.product.member.price * (100 - memberPromotion.discount)
      ) / 100;

    try {
      memberPromotion["priceId"] = await addPrice(
        region,
        event.product.id,
        discountedPrice,
        "member promotion"
      );
    } catch (err) {
      console.log(err.message);
    }
  }

  event.images = images;
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
  event.ticketQR = ticketQR === "true";
  event.ticketName = ticketName === "true";
  event.bgImage = bgImage;
  event.earlyBird = earlyBird;
  event.lateBird = lateBird;
  event.promotion = {
    guest: guestPromotion,
    member: memberPromotion,
  };
  event.googleEventId = googleEventId;

  try {
    await event.save();
    await insertOrUpdateEvent(event);
  } catch (err) {
    console.log(err);
    return next(
      new HttpError(
        "Operations failed! Please try again or contact support!",
        500
      )
    );
  }

  try {
    // await eventToSpreadsheet(event.id);
  } catch {}

  event = event.toObject({ getters: true });

  res.status(200).json({ status: true, event });
};

export const deleteEvent = async (req, res, next) => {
  const eventId = req.params.googleEventId;

  let event;
  try {
    event = await Event.findById(eventId);
  } catch (err) {
    return next(new HttpError("Fetching events failed", 500));
  }

  if (!event) {
    return next(new HttpError("No such event", 404));
  }

  const folder = event.folder ?? "";
  const region = event.region ?? "";
  const productId = event.product.id ?? "";

  try {
    await event.delete();
    await deleteCalendarEvent(event.googleEventId);
  } catch (err) {
    console.log(err);
    return new HttpError(
      "Operations failed! Please try again or contact support!",
      500
    );
  }

  await deleteProduct(region, productId);
  await deleteFolder(folder);
  res.status(200).json({ status: true, eventId });
};
