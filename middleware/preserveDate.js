import moment from "moment-timezone";

export const preserveDateMiddleware = (req, res, next) => {
    if (req.body) {
        const convertDates = (obj) => {
            for (let key in obj) {
                if (typeof obj[key] === 'string') {
                    // Check if the string is a valid date
                    const date = new Date(obj[key]);
                    if (!isNaN(date) && date.toISOString() !== obj[key]) {
                        // If it's a valid date and not already in ISO format
                        const originalMoment = moment(obj[key]);
                        obj[key] = originalMoment.utc().format();
                    }
                } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                    convertDates(obj[key]);
                }
            }
        };

        convertDates(req.body);
    }
    next();
};