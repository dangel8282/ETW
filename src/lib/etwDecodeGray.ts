// Best Focus 등 분석 전용 — grayscale 데이터만 필요할 때 사용.
// BMP는 직접 파싱 (createImageBitmap + getImageData 대비 5~10배 빠름).
// 다른 포맷은 기존 createImageBitmap 경로 fallback.

import type { GrayscaleImage } from './etwAnalyzer';
import { imageDataToGrayscale } from './etwAnalyzer';

export async function decodeImageToGray(file: File): Promise<GrayscaleImage> {
  if (/\.bmp$/i.test(file.name)) {
    return decodeBmpToGray(file);
  }
  return decodeViaImageBitmap(file);
}

async function decodeBmpToGray(file: File): Promise<GrayscaleImage> {
  const buf = await file.arrayBuffer();
  return parseBmpToGray(buf);
}

async function decodeViaImageBitmap(file: File): Promise<GrayscaleImage> {
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close?.();
  return imageDataToGrayscale(imageData);
}

/**
 * BMP V3 (BITMAPINFOHEADER, 40-byte DIB header) 직접 파서.
 * - 24-bit BGR / 32-bit BGRA (uncompressed) 지원
 * - bottom-up / top-down 모두 처리
 * - palettized (8-bit/4-bit/1-bit) 또는 RLE 압축은 미지원 → 에러
 */
export function parseBmpToGray(buffer: ArrayBuffer): GrayscaleImage {
  const view = new DataView(buffer);
  if (view.getUint16(0, true) !== 0x4d42) throw new Error('Not a BMP file');
  const offBits = view.getUint32(10, true);
  // const dibSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const heightRaw = view.getInt32(22, true);
  const bitCount = view.getUint16(28, true);
  const compression = view.getUint32(30, true);

  if (compression !== 0) {
    throw new Error(`BMP compression mode ${compression} not supported`);
  }
  if (bitCount !== 24 && bitCount !== 32) {
    throw new Error(`BMP ${bitCount}-bit not supported (only 24/32)`);
  }

  const isTopDown = heightRaw < 0;
  const height = Math.abs(heightRaw);
  const bpp = bitCount >> 3; // 3 or 4
  // row size in bytes, 4-byte aligned
  const rowSize = ((width * bpp + 3) >> 2) << 2;

  const bytes = new Uint8Array(buffer);
  const gray = new Uint8Array(width * height);
  const inv3 = 1 / 3;

  for (let y = 0; y < height; y++) {
    const srcY = isTopDown ? y : height - 1 - y;
    const srcOff = offBits + srcY * rowSize;
    const dstOff = y * width;
    for (let x = 0; x < width; x++) {
      const p = srcOff + x * bpp;
      // BMP is BGR(A)
      const b = bytes[p];
      const g = bytes[p + 1];
      const r = bytes[p + 2];
      gray[dstOff + x] = ((b + g + r) * inv3) | 0;
    }
  }
  return { width, height, data: gray };
}
