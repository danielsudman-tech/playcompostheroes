import assert from "node:assert/strict";
import { validateCardImage } from "../lib/validateCardImage.js";
import { isCardStagingKey, isServableCardAssetKey } from "../lib/cardAssetStorage.js";

const png = Buffer.alloc(58);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
png.writeUInt32BE(13, 8);
png.write("IHDR", 12);
png.writeUInt32BE(1, 16);
png.writeUInt32BE(1, 20);
png.writeUInt32BE(1, 33);
png.write("IDAT", 37);
png[41] = 0;
png.writeUInt32BE(0, 42);
png.writeUInt32BE(0, 46);
png.write("IEND", 50);

const jpeg = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12,
  0xff, 0xd9,
]);
const webp = Buffer.alloc(24);
webp.write("RIFF", 0);
webp.writeUInt32LE(webp.length - 8, 4);
webp.write("WEBP", 8);
webp.write("VP8 ", 12);
webp.writeUInt32LE(4, 16);

assert.deepEqual(validateCardImage(png, "image/png"), { extension: "png", contentType: "image/png" });
assert.deepEqual(validateCardImage(jpeg, "image/jpeg"), { extension: "jpg", contentType: "image/jpeg" });
assert.deepEqual(validateCardImage(webp, "image/webp"), { extension: "webp", contentType: "image/webp" });
assert.equal(validateCardImage(png, "image/jpeg"), null, "declared MIME must match the file signature");
assert.equal(validateCardImage(Buffer.from("not an image"), "image/png"), null);
assert.equal(validateCardImage(png.subarray(0, 16), "image/png"), null, "truncated image data is rejected");
assert.equal(isCardStagingKey("breezy_bandit", "card-upload-staging/breezy_bandit_random.jpg"), true);
assert.equal(isCardStagingKey("breezy_bandit", "card-overrides/final.jpg"), false);
assert.equal(isCardStagingKey("branch_buddy", "card-upload-staging/breezy_bandit_random.jpg"), false);
assert.equal(isServableCardAssetKey("card-upload-staging/guess.jpg"), false);
assert.equal(isServableCardAssetKey("card-overrides/opaque-final.jpg"), true);

console.log("card image validation tests passed");