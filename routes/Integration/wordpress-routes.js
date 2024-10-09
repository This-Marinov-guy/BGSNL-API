import express from "express";
import { getWordpressPostDetails, getWordpressPosts } from "../../controllers/Integration/wordpress-controllers.js";
import dotenv from "dotenv";
dotenv.config();

const wordpressRouter = express.Router();

wordpressRouter.get("/posts", getWordpressPosts);

wordpressRouter.get("/posts/:postId", getWordpressPostDetails);

export default wordpressRouter;
