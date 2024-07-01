import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";

export const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (token == null) {
        return res.sendStatus(401); 
    }

    jwt.verify(token, process.env.JWT_STRING, (err, user) => {
        if (err) {
            return res.sendStatus(403); 
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
            return res.sendStatus(401);
        }

        jwt.verify(token, process.env.JWT_STRING, (err, user) => {
            if (err) {
                return res.sendStatus(403);
            }

            req.user = user;

            if (!requiredRoles.some(role => user.roles.includes(role))) {
                return res.sendStatus(403);
            }

            next();
        });
    };
};