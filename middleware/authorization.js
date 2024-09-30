import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";
import HttpError from "../models/Http-error.js";

export const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        console.log(`No token!`);
        return next(new HttpError('No access for such request', 401));
    }

    jwt.verify(token, process.env.JWT_STRING, (err, user) => {
        if (err) {
            console.log(`Token: ${token} | Error: ${err}`);
            return next(new HttpError('No access for such request', 403))
        }

        next(); 
    });
};

export const adminMiddleware = (requiredRoles = []) => {
    return (req, res, next) => {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            console.log(`No token!`);
            return next(new HttpError('No access for such request', 401));
        }

        jwt.verify(token, process.env.JWT_STRING, (err, user) => {
            if (err) {
                console.log(`Token: ${token} | Error: ${err}`);
                return next(new HttpError('No access for such request', 403));
            }

            if (!requiredRoles.some(role => user['roles'].includes(role))) {
                console.log(`Token: ${token} | Error: No role rights for such request`);
                return next(new HttpError('No access for such request', 403));
            }

            next();
        });
    };
};
