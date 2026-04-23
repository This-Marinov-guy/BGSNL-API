import axios from "axios";
import AWS from "aws-sdk";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import sharp from "sharp";
import { fileURLToPath } from "url";
import User from "../../models/User.js";

const DEFAULT_TICKET_COLOR = "#faf9f6";
const DEFAULT_TICKET_WIDTH = 1500;
const DEFAULT_TICKET_HEIGHT = 485;

const NAME_FONT_SIZE = 52;
const QUANTITY_FONT_SIZE = 42;
const MULTIPLIER_FONT_SIZE = 25;

const NAME_TEXT_BOX_HEIGHT = 86;
const QUANTITY_TEXT_BOX_WIDTH = 160;
const QUANTITY_TEXT_BOX_HEIGHT = 84;
const MULTIPLIER_TEXT_BOX_WIDTH = 48;
const MULTIPLIER_TEXT_BOX_HEIGHT = 48;

const NAME_LEFT_COLUMN_X = 1210;
const SURNAME_LEFT_COLUMN_X = 1270;
const QUANTITY_CENTER_X = 1380;
const QUANTITY_CENTER_Y_FROM_BOTTOM = 110;
const MULTIPLIER_CENTER_X = 1345;
const MULTIPLIER_CENTER_Y_FROM_BOTTOM = 115;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedArchiveFontPath = null;
let cachedArchiveFontBase64 = null;
const ARCHIVE_FONT_FAMILIES = [
  "Archive Regular",
  "Archive-Regular",
  "Archive",
];

const escapeXml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");

const sanitizeKeyPart = (value = "") =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "")
    .slice(0, 60);

const normalizeColor = (color) =>
  /^#([0-9a-f]{3,8})$/i.test(color ?? "") ? color : DEFAULT_TICKET_COLOR;

const splitGuestName = (guestName = "") => {
  const chunks = String(guestName).trim().split(/\s+/).filter(Boolean);
  if (chunks.length === 0) {
    return { name: "Guest", surname: "" };
  }
  if (chunks.length === 1) {
    return { name: chunks[0], surname: "" };
  }
  return { name: chunks[0], surname: chunks.slice(1).join(" ") };
};

const buildGuestCheckLink = ({ originUrl, eventId, code, quantity }) => {
  const baseUrl = (originUrl || "https://www.bulgariansociety.nl").replace(
    /\/$/,
    "",
  );
  return `${baseUrl}/user/check-guest-list?event=${encodeURIComponent(
    eventId,
  )}&code=${encodeURIComponent(code)}&count=${encodeURIComponent(quantity)}`;
};

const resolveArchiveFontPath = async () => {
  if (cachedArchiveFontPath !== null) {
    if (cachedArchiveFontPath) {
      try {
        await fs.promises.access(cachedArchiveFontPath);
      } catch {
        cachedArchiveFontPath = "";
      }
    }
    return cachedArchiveFontPath;
  }

  const candidates = [
    process.env.ARCHIVE_FONT_PATH,
    path.resolve(__dirname, "../../assets/fonts/Archive-Regular.ttf"),
  ].filter(Boolean);

  let found = "";
  for (const p of candidates) {
    try {
      await fs.promises.access(p);
      found = p;
      break;
    } catch {
      // path not available
    }
  }

  cachedArchiveFontPath = found;
  return cachedArchiveFontPath;
};

const getArchiveFontBase64 = async () => {
  if (cachedArchiveFontBase64 !== null) {
    return cachedArchiveFontBase64;
  }

  const fontPath = await resolveArchiveFontPath();
  if (!fontPath) {
    cachedArchiveFontBase64 = "";
    return cachedArchiveFontBase64;
  }

  try {
    const fontBuffer = await fs.promises.readFile(fontPath);
    cachedArchiveFontBase64 = fontBuffer.toString("base64");
    return cachedArchiveFontBase64;
  } catch (err) {
    console.error("[ticket] Failed to read font file:", err.message);
    cachedArchiveFontBase64 = "";
    return cachedArchiveFontBase64;
  }
};

const createTextSvgBuffer = async ({
  text,
  width,
  height,
  fontSize,
  color,
}) => {
  const safeText = String(text ?? "").trim();
  if (!safeText) {
    return null;
  }

  const fontBase64 = await getArchiveFontBase64();

  const fontFace = fontBase64
    ? `
      @font-face {
        font-family: 'Archive Regular';
        src: url("data:font/ttf;charset=utf-8;base64,${fontBase64}") format("truetype");
        font-weight: 400;
        font-style: normal;
      }
    `
    : "";

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(
      1,
      Math.round(width),
    )}" height="${Math.max(1, Math.round(height))}" viewBox="0 0 ${Math.max(
      1,
      Math.round(width),
    )} ${Math.max(1, Math.round(height))}">
      <style>
        ${fontFace}
        .label {
          font-family: 'Archive Regular', 'Archive-Regular', 'Archive', sans-serif;
          font-size: ${fontSize}px;
          font-weight: 400;
          font-style: normal;
          fill: ${color};
        }
      </style>
      <rect width="100%" height="100%" fill="transparent" />
      <text
        class="label"
        x="50%"
        y="50%"
        text-anchor="middle"
        dominant-baseline="central"
        xml:space="preserve"
      >${escapeXml(safeText)}</text>
    </svg>
  `;

  return Buffer.from(svg);
};

const createTextOverlayBuffer = async ({
  text,
  width,
  height,
  fontSize,
  color,
  fontPath, // kept only so your call sites stay unchanged
}) => {
  const safeText = String(text ?? "").trim();
  if (!safeText) {
    return null;
  }

  if (fontPath) {
    for (const fontFamily of ARCHIVE_FONT_FAMILIES) {
      try {
        return await sharp({
          text: {
            text: `<span foreground="${color}">${escapeXml(safeText)}</span>`,
            rgba: true,
            width: Math.max(1, Math.round(width)),
            height: Math.max(1, Math.round(height)),
            align: "center",
            dpi: 300,
            font: `${fontFamily} ${fontSize}`,
            fontfile: fontPath,
          },
        })
          .png()
          .toBuffer();
      } catch (_) {
        // Try the next Archive family alias before falling back.
      }
    }
  }

  try {
    const svgBuffer = await createTextSvgBuffer({
      text: safeText,
      width,
      height,
      fontSize,
      color,
    });

    return await sharp(svgBuffer).png().toBuffer();
  } catch (err) {
    console.error("[ticket] SVG text render failed:", {
      text: safeText,
      error: err.message,
      fontPath,
    });

    // fallback to your previous behavior
    try {
      return await sharp({
        text: {
          text: `<span foreground="${color}">${escapeXml(safeText)}</span>`,
          rgba: true,
          width: Math.max(1, Math.round(width)),
          height: Math.max(1, Math.round(height)),
          align: "center",
          dpi: 300,
          font: `sans ${fontSize}`,
        },
      })
        .png()
        .toBuffer();
    } catch (_) {
      return null;
    }
  }
};

const createVerticalLabelBuffer = async ({
  text,
  ticketHeight,
  color,
  fontPath, // kept only so your call sites stay unchanged
}) => {
  const horizontalTextBuffer = await createTextOverlayBuffer({
    text,
    width: ticketHeight,
    height: NAME_TEXT_BOX_HEIGHT,
    fontSize: NAME_FONT_SIZE,
    color,
    fontPath,
  });

  if (!horizontalTextBuffer) {
    return null;
  }

  return await sharp(horizontalTextBuffer)
    .rotate(-90, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
};

const pushCenteredOverlay = async ({
  composites,
  buffer,
  centerX,
  centerY,
}) => {
  if (!buffer) {
    return;
  }

  const metadata = await sharp(buffer).metadata();
  const overlayWidth = metadata.width || 0;
  const overlayHeight = metadata.height || 0;

  composites.push({
    input: buffer,
    left: Math.max(0, Math.round(centerX - overlayWidth / 2)),
    top: Math.max(0, Math.round(centerY - overlayHeight / 2)),
  });
};

const resolveTicketHolder = async ({
  checkoutType,
  guestName,
  userId,
  memberUser,
}) => {
  if (checkoutType === "member") {
    if (memberUser?.name) {
      return { name: memberUser.name, surname: memberUser.surname || "" };
    }

    if (!userId) {
      return { name: "Member", surname: "" };
    }

    let user = null;
    try {
      user = await User.findById(userId);
    } catch (_) {
      user = null;
    }

    if (!user) {
      return { name: "Member", surname: "" };
    }

    return { name: user.name || "Member", surname: user.surname || "" };
  }

  return splitGuestName(guestName);
};

const uploadBufferToS3 = async ({ buffer, bucketName, key }) => {
  const s3 = new AWS.S3({
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  });

  const uploadedFile = await s3
    .upload({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: "image/webp",
    })
    .promise();

  return uploadedFile.Location;
};

export const generateAndUploadEventTicket = async ({
  event,
  checkoutType = "guest",
  bucketName,
  originUrl,
  code,
  quantity = 1,
  guestName = "",
  userId = "",
  memberUser = null,
}) => {
  if (!event?.ticketImg) {
    throw new Error("Missing event ticket template image");
  }

  if (!bucketName) {
    throw new Error("Missing bucket for ticket upload");
  }

  const safeQuantity = Number(quantity) > 0 ? Number(quantity) : 1;
  const safeColor = normalizeColor(event.ticketColor);
  const { name, surname } = await resolveTicketHolder({
    checkoutType,
    guestName,
    userId,
    memberUser,
  });

  const imageResponse = await axios.get(event.ticketImg, {
    responseType: "arraybuffer",
    timeout: 15000,
  });

  const resizedTicketImage = await sharp(Buffer.from(imageResponse.data))
    .resize(DEFAULT_TICKET_WIDTH, DEFAULT_TICKET_HEIGHT, { fit: "fill" })
    .toBuffer();

  const baseImageMetadata = await sharp(resizedTicketImage).metadata();
  const width = baseImageMetadata.width ?? DEFAULT_TICKET_WIDTH;
  const height = baseImageMetadata.height ?? DEFAULT_TICKET_HEIGHT;
  const archiveFontPath = await resolveArchiveFontPath();

  const composites = [];

  if (event.ticketName) {
    const nameBuffer = await createVerticalLabelBuffer({
      text: name,
      ticketHeight: height,
      color: safeColor,
      fontPath: archiveFontPath,
    });

    const surnameBuffer = await createVerticalLabelBuffer({
      text: surname,
      ticketHeight: height,
      color: safeColor,
      fontPath: archiveFontPath,
    });

    await pushCenteredOverlay({
      composites,
      buffer: nameBuffer,
      centerX: NAME_LEFT_COLUMN_X,
      centerY: height / 2,
    });

    await pushCenteredOverlay({
      composites,
      buffer: surnameBuffer,
      centerX: SURNAME_LEFT_COLUMN_X,
      centerY: height / 2,
    });
  }

  if (event.ticketQR) {
    const qrLink = buildGuestCheckLink({
      originUrl,
      eventId: event.id || event._id?.toString() || "",
      code: code || Date.now(),
      quantity: safeQuantity,
    });

    const qrBuffer = await QRCode.toBuffer(qrLink, {
      type: "png",
      width: 200,
      margin: 0,
    });
    const qrResized = await sharp(qrBuffer).resize(80, 80).png().toBuffer();

    composites.push({
      input: qrResized,
      left: 1330,
      top: Math.max(height - 380, 0),
    });
  }

  if (safeQuantity > 1) {
    const quantityBuffer = await createTextOverlayBuffer({
      text: String(safeQuantity),
      width: QUANTITY_TEXT_BOX_WIDTH,
      height: QUANTITY_TEXT_BOX_HEIGHT,
      fontSize: QUANTITY_FONT_SIZE,
      color: safeColor,
      fontPath: archiveFontPath,
    });

    const multiplierBuffer = await createTextOverlayBuffer({
      text: "x",
      width: MULTIPLIER_TEXT_BOX_WIDTH,
      height: MULTIPLIER_TEXT_BOX_HEIGHT,
      fontSize: MULTIPLIER_FONT_SIZE,
      color: safeColor,
      fontPath: archiveFontPath,
    });

    await pushCenteredOverlay({
      composites,
      buffer: quantityBuffer,
      centerX: QUANTITY_CENTER_X,
      centerY: height - QUANTITY_CENTER_Y_FROM_BOTTOM,
    });

    await pushCenteredOverlay({
      composites,
      buffer: multiplierBuffer,
      centerX: MULTIPLIER_CENTER_X,
      centerY: height - MULTIPLIER_CENTER_Y_FROM_BOTTOM,
    });
  }

  const finalTicketBuffer = await sharp(resizedTicketImage)
    .composite(composites)
    .webp({ quality: 100 })
    .toBuffer();

  const key = `${sanitizeKeyPart(
    event.id || event._id?.toString() || "event",
  )}_${sanitizeKeyPart(code || Date.now())}_${sanitizeKeyPart(
    checkoutType,
  )}_${sanitizeKeyPart(name)}_${Date.now()}.webp`;

  return await uploadBufferToS3({
    buffer: finalTicketBuffer,
    bucketName,
    key,
  });
};
