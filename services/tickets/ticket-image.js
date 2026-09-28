// Accept a Sharp pipeline so generated overlays are encoded only once.
// Preserve aspect ratio and never enlarge small uploads. Generated tickets
// retain their existing 1500 × 485 layout, including QR module dimensions.
export const encodeTicketImage = image => image
  .rotate()
  .resize({ width: 1500, height: 1500, fit: "inside", withoutEnlargement: true })
  .webp({ quality: 85, alphaQuality: 100, effort: 6 })
  .toBuffer();
