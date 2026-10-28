import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { estimateMessageTokens } from './agent-runner.js';
import { AGENT_IMAGE_EDGE, imageTokens, toVisionImage } from './agent-images.js';

describe('photos for the model', () => {
  it('scales a large photo down to fit, as JPEG without its metadata', async () => {
    const png = await sharp({
      create: {
        width: 3000,
        height: 2000,
        channels: 4,
        background: { r: 200, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .withExif({ IFD0: { Copyright: 'secret place' } })
      .toBuffer();
    expect((await sharp(png).metadata()).exif).toBeDefined();
    const img = await toVisionImage(png);
    expect(img).toMatchObject({ mediaType: 'image/jpeg', width: AGENT_IMAGE_EDGE, height: 853 });
    const out = await sharp(Buffer.from(img!.data, 'base64')).metadata();
    expect(out).toMatchObject({ format: 'jpeg', width: AGENT_IMAGE_EDGE, height: 853 });
    expect(out.exif).toBeUndefined();
    expect(out.hasAlpha).toBe(false);
  });

  it('turns a phone photo upright and never enlarges a small one', async () => {
    // Stored 400×200 with "rotate 90°" in its EXIF, as phones do.
    const sideways = await sharp({
      create: { width: 400, height: 200, channels: 3, background: '#336699' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(await toVisionImage(sideways)).toMatchObject({ width: 200, height: 400 });
  });

  it('returns null for bytes that are not an image', async () => {
    expect(await toVisionImage(Buffer.from('not an image at all'))).toBeNull();
  });

  it('reserves tokens for photos by their area, not by their base64 text', () => {
    expect(imageTokens({ width: 1280, height: 853 })).toBe(1456);
    const text = { role: 'user' as const, text: 'eta ache?' };
    const withPhoto = {
      ...text,
      images: [
        {
          mediaType: 'image/jpeg' as const,
          data: 'A'.repeat(400_000),
          width: 1280,
          height: 853,
        },
      ],
    };
    expect(estimateMessageTokens([withPhoto]) - estimateMessageTokens([text])).toBe(1456);
  });
});
