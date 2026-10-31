// Photo resizing/compression in the browser (canvas), before upload.

export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_QUALITY = 0.8;
export const THUMB_MAX_SIDE = 320;
export const THUMB_QUALITY = 0.7;
export const MAX_INPUT_BYTES = 30 * 1024 * 1024;

async function decode(file) {
  try {
    // EXIF orientation is applied ("from-image" is the default in current browsers).
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    throw new Error(`image decode failed: ${e.message}`);
  }
}

function toJpeg(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs become white instead of black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas toBlob failed'))), 'image/jpeg', quality);
  });
}

// Returns { photo: Blob, thumb: Blob }. Throws Error with an English message on failure.
export async function compressImage(file) {
  if (!file.type.startsWith('image/')) throw new Error(`not an image: ${file.type}`);
  if (file.size > MAX_INPUT_BYTES) throw new Error(`image too large: ${file.size}`);
  const bitmap = await decode(file);
  try {
    const photo = await toJpeg(bitmap, PHOTO_MAX_SIDE, PHOTO_QUALITY);
    const thumb = await toJpeg(bitmap, THUMB_MAX_SIDE, THUMB_QUALITY);
    return { photo, thumb };
  } finally {
    bitmap.close();
  }
}
