import sharp from 'sharp';
import type { AiImage } from '../provider/ai-provider.js';

/** Photos the agent looks at per reply: the customer's most recent ones. */
export const MAX_AGENT_IMAGES = 3;
/**
 * Longest side sent to the model. Vision models charge by pixel area, and a product photo
 * at this size still shows colour, pattern and print clearly.
 */
export const AGENT_IMAGE_EDGE = 1280;
/** Larger inputs are not decoded at all (a defence against decompression bombs). */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Prepares a customer's photo for the model: turned upright, scaled down to fit
 * AGENT_IMAGE_EDGE, re-encoded as JPEG (which also drops metadata such as location).
 * Returns null when the bytes are not a readable image.
 */
export async function toVisionImage(bytes: Buffer): Promise<AiImage | null> {
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: AGENT_IMAGE_EDGE,
        height: AGENT_IMAGE_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      mediaType: 'image/jpeg',
      data: data.toString('base64'),
      width: info.width,
      height: info.height,
    };
  } catch {
    return null;
  }
}

/**
 * Input tokens a photo costs at most: providers count pixel area (Anthropic documents
 * about width × height / 750). Used to reserve credits before the call, never to bill.
 */
export function imageTokens(img: Pick<AiImage, 'width' | 'height'>): number {
  return Math.ceil((img.width * img.height) / 750);
}
