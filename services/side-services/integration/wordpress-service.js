export const pairTranslatedPosts = (posts, translatedPostsIds) => {
  let processedPosts = [...posts];

  for (let i = 0; i < translatedPostsIds.length; i += 2) {
    const enId = translatedPostsIds[i];
    const bgId = translatedPostsIds[i + 1];

    // Find the English and Bulgarian posts
    const enPost = processedPosts.find((post) => post.id == enId);
    const bgPost = processedPosts.find((post) => post.id == bgId);

    // If both posts exist, modify the English post and mark Bulgarian post for removal
    if (enPost && bgPost) {
      const enPostIndex = processedPosts.findIndex((post) => post.id == enId);

      // Modify the English post
      processedPosts[enPostIndex] = {
        withTranslation: true,
        en: { ...enPost },
        bg: { ...bgPost },
      };

      // Remove the Bulgarian post
      processedPosts = processedPosts.filter((post) => post.id != bgId);
    }
  }

  return processedPosts;
}

export const removeBgPosts = (posts, translatedPostsIds) => {
  // Get all Bulgarian post IDs (every second item in translatedPostsIds)
  const bgIds = translatedPostsIds.filter((_, index) => index % 2 === 1);

  // Return new array without the Bulgarian posts
  return posts.filter((post) => !bgIds.includes(post.id.toString()));
}

export const checkPostTranslation = (postId, translatedPostsIds) => {
  // Initialize result object
  const result = {
    withTranslation: false,
    translations: null,
  };

  // Go through translatedPostsIds two at a time
  for (let i = 0; i < translatedPostsIds.length; i += 2) {
    const enId = translatedPostsIds[i];
    const bgId = translatedPostsIds[i + 1];

    // Check if current postId matches either English or Bulgarian ID
    if (postId == enId || postId == bgId) {
      result.withTranslation = true;
      result.translations = {
        en: enId,
        bg: bgId,
      };
      break;
    }
  }

  return result;
}