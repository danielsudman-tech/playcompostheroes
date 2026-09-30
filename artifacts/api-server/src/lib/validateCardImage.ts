export type SupportedCardImage = {
  extension: "png" | "jpg" | "webp";
  contentType: "image/png" | "image/jpeg" | "image/webp";
};

export function validateCardImage(bytes: Buffer, declaredType: unknown): SupportedCardImage | null {
  if (declaredType === "image/png" && isPng(bytes)) {
    return { extension: "png", contentType: "image/png" };
  }
  if (declaredType === "image/jpeg" && isJpeg(bytes)) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (declaredType === "image/webp" && isWebp(bytes)) {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
}

function isPng(bytes: Buffer): boolean {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(signature)) return false;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
  if (bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0) return false;
  let offset = 8;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT" && length > 0) hasImageData = true;
    offset += 12 + length;
    if (type === "IEND") return length === 0 && hasImageData && offset === bytes.length;
  }
  return false;
}

function isJpeg(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  let offset = 2;
  let hasFrame = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    if (marker === 0xd9) return false;
    if (marker === 0xda) {
      if (!hasFrame || offset + 2 > bytes.length) return false;
      const scanLength = bytes.readUInt16BE(offset);
      return scanLength >= 6 && offset + scanLength < bytes.length - 2;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;
    if ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)) hasFrame = true;
    offset += segmentLength;
  }
  return false;
}

function isWebp(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP" ||
      bytes.readUInt32LE(4) !== bytes.length - 8) return false;
  let offset = 12;
  let hasImageData = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    if (length > bytes.length - offset - 8) return false;
    if (type === "VP8 " || type === "VP8L" || type === "VP8X") hasImageData = length > 0;
    offset += 8 + length + (length % 2);
  }
  return hasImageData && offset === bytes.length;
}
