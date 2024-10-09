import HttpError from "../../models/Http-error.js";
import axios from "axios";
import dotenv from "dotenv";
import { PROTOCOL } from "../../util/config/access.js";
import { DEFAULT_WP_TITLES } from "../../util/config/defines.js";
dotenv.config();

const ENDPOINT = "public-api.wordpress.com/wp/v2/sites/";

export const getWordpressPosts = async (req, res, next) => {
  let response = null;
  try {
    response = await axios.get(
      `${PROTOCOL}${ENDPOINT}${process.env.WORDPRESS_BLOG_ID}/posts`
    );
  } catch (err) {
    return next(new HttpError(err, 500));
  }

  if (!response.data) {
    return next(new HttpError("Failed to load posts", 500));
  }

  const posts = response.data.map((p) => {
    return {
      id: p.id,
      title: p.title.rendered.replace(/&nbsp;/g, " "),
    };
  });

  return res.status(200).json({ status: true, posts });
};

export const getWordpressPostDetails = async (req, res, next) => {
  const postId = req.params.postId;
  let response = null;
  let responseStyles = null;

  try {
    response = await axios.get(
      `${PROTOCOL}${ENDPOINT}${process.env.WORDPRESS_BLOG_ID}/posts/${postId}?_embed`
    );
  } catch (err) {
    console.log(err.message);

    return res.status(200).json({
      status: false,
    });
  }

  try {
    responseStyles = await axios.get(
      `${PROTOCOL}${process.env.WORDPRESS_BLOG_ID}/wp-includes/css/dist/block-library/style.min.css`
    );
  } catch (err) {
    console.log(err.message);
  }

  const post = response.data;

  if (!post) {
    return next(new HttpError("Failed to load post", 500));
  }

  // Replace http with https
  let processedContent = post.content.rendered.replace(
    /http:\/\//g,
    "https://"
  );

  // Fix relative image paths
  processedContent = processedContent.replace(
    /src="\/wp-content/g,
    `src=${ENDPOINT}${process.env.WORDPRESS_BLOG_ID}/wp-content`
  );

  return res.status(200).json({
    status: true,
    data: {
      title: post.title.rendered.replace(/&nbsp;/g, " ") ?? null,
      content: processedContent ?? null,
      styles: responseStyles.data ?? null,
    },
  });
};
