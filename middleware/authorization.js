import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";
import HttpError from "../models/Http-error.js";
import { decodeJWT } from "../util/functions/security.js";

export const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (token == null) {
        return next(new HttpError('No access for such request', 401))
    }

    jwt.verify(token, process.env.JWT_STRING, (err, user) => {
        if (err) {
            return next(new HttpError('No access for such request', 403))
        }

        req.user = user;    
        next(); 
    });
};

export const adminMiddleware = (requiredRoles = []) => {
    return (req, res, next) => {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (token == null) {
            return next(new HttpError('No access for such request', 401))
        }

        jwt.verify(token, process.env.JWT_STRING, (err, user) => {
            if (err) {
                return next(new HttpError('No access for such request', 403))
            }

            const userRoles = decodeJWT(token)['roles'];

            if (!requiredRoles.some(role => userRoles.includes(role))) {
                return next(new HttpError('No access for such request', 403))
            }

            next();
        });
    };
};