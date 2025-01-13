import HttpError from "../../models/Http-error.js";
import axios from "axios";
import dotenv from "dotenv";
import { PROTOCOL } from "../../util/config/access.js";
import { DEFAULT_WP_TITLES } from "../../util/config/defines.js";
import { readSpreadsheetRows } from "../../services/side-services/google-spreadsheets.js";
import { ARTICLES_SHEET } from "../../util/config/SPREEDSHEATS.js";
import {
  checkPostTranslation,
  pairTranslatedPosts,
  removeBgPosts,
} from "../../services/side-services/integration/wordpress-service.js";
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

  const posts = response.data.map((p, index) => {
    // Replace http with https
    let processedContent = p.content.rendered.replace(/http:\/\//g, "https://");

    // Fix relative image paths
    processedContent = processedContent.replace(
      /src="\/wp-content/g,
      `src=${ENDPOINT}${process.env.WORDPRESS_BLOG_ID}/wp-content`
    );

    const matches = processedContent.match(/<img[^>]+src="([^">]+)"/);
    const firstImageSrc = matches ? matches[1] : null;

    const match = processedContent.match(/<p[^>]*>([^<|&]+)<\/p>/);
    let description = match
      ? match[1].trim()
      : "Curious to learn more about this article? Click below and jump right to it!";

    if (index !== 0) {
      description =
        description.trim().slice(0, 80) +
        (description.trim().length > 80 ? "..." : "");
    }

    return {
      id: p.id,
      thumbnail: firstImageSrc,
      title: p.title.rendered.replace(/&nbsp;/g, " "),
      description: description,
    };
  });

  const translatedPostsIds = await readSpreadsheetRows(
    ARTICLES_SHEET,
    "Translations",
    "B2",
    `C${posts.length + 1}`
  );

  const enPosts = removeBgPosts(posts, translatedPostsIds);

  return res.status(200).json({ status: true, posts: enPosts });
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

  // TODO: make the C digit dynamic
  const translatedPostsIds = await readSpreadsheetRows(
    ARTICLES_SHEET,
    "Translations",
    "B2",
    `C${6}`
  );

  const translatedPost = checkPostTranslation(post.id, translatedPostsIds);
  
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
      ...translatedPost,
      title: post.title.rendered.replace(/&nbsp;/g, " ") ?? null,
      content: processedContent ?? null,
      styles: responseStyles.data ?? null,
    },
  });
};
