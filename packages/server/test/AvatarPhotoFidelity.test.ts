import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { UpdateUserInfo } from '../src/services/UpdateUserInfo';

/**
 * Pixel-fidelity contract of THE avatar image pipeline (`toAvatarJpeg` — the only place avatar
 * pixels are ever resampled), tested straight through the pipeline with no DB: a stored master
 * never contains invented (enlarged) pixels, honors the client's crop frame exactly, and still
 * caps large sources at 512. This is the categorical guard for the founder's fuzzy-avatar
 * defect: a small source blown up to a fixed 512 master reads as permanent blur on every chip
 * that renders it.
 *
 * Helpers are reached via the house typed-cast-on-an-instance pattern (no widening of the
 * class surface).
 */
type AvatarPipelineInternals = {
  toAvatarJpeg(imageBytes: Buffer, mimeType: string, crop?: { sx: number; sy: number; size: number }): Promise<Buffer>;
};

const pipeline = () => new UpdateUserInfo() as unknown as AvatarPipelineInternals;

const solidPng = async (width: number, height: number, rgb: { r: number; g: number; b: number }) =>
  await sharp({ create: { width, height, channels: 3, background: rgb } })
    .png()
    .toBuffer();

const dimensionsOf = async (jpeg: Buffer) => {
  const metadata = await sharp(jpeg).metadata();
  return { width: metadata.width, height: metadata.height, format: metadata.format };
};

/** Average color of the whole output — crop-mapping assertions read regions, not single pixels. */
const averageColor = async (jpeg: Buffer) => {
  const stats = await sharp(jpeg).stats();
  const [r, g, b] = stats.channels.map((channel) => channel.mean);
  return { r, g, b };
};

describe('avatar photo pixel fidelity', () => {
  it('keeps a small source at its honest pixel count — never enlarged to the 512 cap', async () => {
    const png = await solidPng(96, 96, { r: 200, g: 80, b: 40 });

    const jpeg = await pipeline().toAvatarJpeg(png, 'image/png');

    // The defect: the old pipeline resized EVERYTHING to a fixed 512 square, inventing 5x the
    // pixels for a 96px source — permanent blur baked into the master.
    expect(await dimensionsOf(jpeg)).toEqual({ width: 96, height: 96, format: 'jpeg' });
  });

  it('center-crops a small non-square source to its honest square (no enlargement)', async () => {
    const png = await solidPng(300, 200, { r: 10, g: 120, b: 210 });

    const jpeg = await pipeline().toAvatarJpeg(png, 'image/png');

    expect(await dimensionsOf(jpeg)).toEqual({ width: 200, height: 200, format: 'jpeg' });
  });

  it('extracts exactly the client-framed crop square', async () => {
    // Left half blue, right half red; the client frames the right half.
    const left = await solidPng(100, 100, { r: 20, g: 40, b: 220 });
    const source = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 220, g: 30, b: 30 } },
    })
      .composite([{ input: left, left: 0, top: 0 }])
      .png()
      .toBuffer();

    const jpeg = await pipeline().toAvatarJpeg(source, 'image/png', { sx: 100, sy: 0, size: 100 });

    expect(await dimensionsOf(jpeg)).toEqual({ width: 100, height: 100, format: 'jpeg' });
    const color = await averageColor(jpeg);
    expect(color.r).toBeGreaterThan(180);
    expect(color.b).toBeLessThan(80);
  });

  it('clamps an out-of-bounds crop inside the image, staying square', async () => {
    const png = await solidPng(300, 200, { r: 90, g: 90, b: 90 });

    const jpeg = await pipeline().toAvatarJpeg(png, 'image/png', { sx: 250, sy: 150, size: 120 });

    expect(await dimensionsOf(jpeg)).toEqual({ width: 120, height: 120, format: 'jpeg' });
  });

  it('still lands a large source at the 512 cap', async () => {
    const png = await solidPng(1024, 768, { r: 40, g: 160, b: 90 });

    const jpeg = await pipeline().toAvatarJpeg(png, 'image/png');

    expect(await dimensionsOf(jpeg)).toEqual({ width: 512, height: 512, format: 'jpeg' });
  });

  it('keeps a small HEIC source at its honest centered square (the WASM decode path)', async () => {
    // The 96x64 fixture: centered 64px square, not an enlarged 512.
    const heic = fs.readFileSync(path.join(__dirname, 'fixtures', 'fixture.heic'));

    const jpeg = await pipeline().toAvatarJpeg(heic, 'image/heic');

    expect(await dimensionsOf(jpeg)).toEqual({ width: 64, height: 64, format: 'jpeg' });
  });

  it('rejects a non-numeric crop in plain words', async () => {
    const png = await solidPng(64, 64, { r: 10, g: 10, b: 10 });

    await expect(pipeline().toAvatarJpeg(png, 'image/png', { sx: NaN, sy: 0, size: 32 })).rejects.toThrow(
      'Avatar crop must be numeric'
    );
  });
});
