import { createHash } from "node:crypto";
import { IS_PROD } from "../../util/functions/helpers.js";
import { copyCloudinaryImage } from "../../util/functions/cloudinary.js";

export const publishedEventFolder = (id) =>
  `${IS_PROD ? "" : "development/"}events/${id}`;

export async function copyDraftEventMedia(draft, media, folder, { copy = copyCloudinaryImage } = {}) {
  const draftUrls = new Set([
    draft.poster, draft.ticketImg, ...(draft.images || []),
    draft.draftData?.poster, draft.draftData?.ticketImg, ...(draft.draftData?.images || []),
  ].filter(Boolean));
  const draftFolderPath = draft.folder ? `/${draft.folder}/` : null;
  const isInDraftFolder = (url) => {
    if (typeof url !== "string" || !draftFolderPath) return false;
    try { return new URL(url).pathname.includes(draftFolderPath); }
    catch { return false; }
  };
  const copied = new Map();
  const copyIfDraft = async (url, publicId) => {
    if (!draftUrls.has(url) && !isInDraftFolder(url)) return url;
    if (!copied.has(url)) {
      copied.set(url, copy(url, {
        folder,
        asset_folder: folder,
        public_id_prefix: folder,
        public_id: publicId,
      }));
    }
    return await copied.get(url);
  };

  return {
    poster: await copyIfDraft(media.poster, "poster"),
    ticketImg: await copyIfDraft(media.ticketImg, "ticket"),
    images: await Promise.all((media.images || []).map((url) =>
      copyIfDraft(url, `image_${createHash("sha256").update(url).digest("hex").slice(0, 20)}`))),
  };
}
