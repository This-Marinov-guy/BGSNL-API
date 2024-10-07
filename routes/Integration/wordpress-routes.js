import express from "express";
import dotenv from "dotenv";
import { getWordpressPostDetails, getWordpressPosts } from "../../controllers/Integration/wordpress-controllers.js";
dotenv.config();

const wordpressRouter = express.Router();

wordpressRouter.get("/posts", getWordpressPosts);

wordpressRouter.get("/posts/:postId", getWordpressPostDetails);

export default wordpressRouter;
