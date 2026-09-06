import { inflateSync } from 'node:zlib';
import { imageDimensionsFromData } from 'image-dimensions';
import { PNG } from 'pngjs';

export const MAX_IMAGE_MASK_BYTES = 4_000_000;
const MAX_MASK_PIXELS = 16_777_216;

/** Bound inflation before the decoder's interlaced path can allocate from compressed input. */
function boundPngInflation(bytes: Buffer, width: number, height: number): void {
  const chunks: Buffer[] = [];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('The PNG mask is truncated');
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset === 8 ? kind !== 'IHDR' || length !== 13 : kind === 'IHDR')
      throw new Error('The PNG mask has an invalid header');
    if (kind === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset = end;
    if (kind === 'IEND') {
      if (length !== 0 || offset !== bytes.length)
        throw new Error('The PNG mask has unexpected trailing data');
      ended = true;
      break;
    }
  }
  if (!ended || !chunks.length) throw new Error('The PNG mask is incomplete');
  // Sixteen-bit RGBA plus the scanline bytes of all interlace passes is the upper bound.
  inflateSync(Buffer.concat(chunks), { maxOutputLength: width * height * 8 + height * 7 + 4096 });
}

export function validateImageMask(mask: Buffer, reference: Buffer): void {
  if (!mask.length || mask.length >= MAX_IMAGE_MASK_BYTES)
    throw new Error('Choose a PNG mask smaller than 4 MB');
  const geometry = imageDimensionsFromData(mask);
  const image = imageDimensionsFromData(reference);
  if (
    !geometry ||
    geometry.type !== 'png' ||
    !image ||
    !['png', 'jpeg', 'webp'].includes(image.type)
  )
    throw new Error('Choose a valid PNG mask and PNG, JPEG or WebP reference');
  if (
    geometry.width < 1 ||
    geometry.height < 1 ||
    geometry.width * geometry.height > MAX_MASK_PIXELS
  )
    throw new Error('The mask exceeds the local decoded pixel limit');
  if (geometry.width !== image.width || geometry.height !== image.height)
    throw new Error('The mask must match the first reference image dimensions');
  let decoded: ReturnType<typeof PNG.sync.read>;
  try {
    boundPngInflation(mask, geometry.width, geometry.height);
    decoded = PNG.sync.read(mask, { checkCRC: true, skipRescale: true });
  } catch {
    throw new Error('Choose a complete PNG mask with valid pixels and checksums');
  }
  if (!decoded.alpha) throw new Error('The mask needs an alpha channel');
  let editable = false;
  for (let offset = 3; offset < decoded.data.length; offset += 4) {
    if (decoded.data[offset] === 0) {
      editable = true;
      break;
    }
  }
  if (!editable) throw new Error('The mask needs a fully transparent area to edit');
}
