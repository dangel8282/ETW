// Best Focus 등 분석 전용 — grayscale 데이터만 필요할 때 사용.
// BMP는 직접 파싱 (createImageBitmap + getImageData 대비 5~10배 빠름).
// 다른 포맷은 기존 createImageBitmap 경로 fallback.

import type { GrayscaleImage } from './etwAnalyzer';
import { imageDataToGrayscale } from './etwAnalyzer';
import type { BestFocusRoi } from './etwBestFocus';

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
  if (bitCount !== 8 && bitCount !== 24 && bitCount !== 32) {
    throw new Error(`BMP ${bitCount}-bit not supported (only 8/24/32)`);
  }

  const isTopDown = heightRaw < 0;
  const height = Math.abs(heightRaw);
  const bytes = new Uint8Array(buffer);
  const gray = new Uint8Array(width * height);

  if (bitCount === 8) {
    // 8-bit indexed (대부분 line-scan grayscale BMP는 identity palette).
    // pixel byte 를 그대로 grayscale 로 취급.
    const rowSize = ((width + 3) >> 2) << 2;
    for (let y = 0; y < height; y++) {
      const srcY = isTopDown ? y : height - 1 - y;
      const srcOff = offBits + srcY * rowSize;
      const dstOff = y * width;
      // 한 row 통째 복사 — Uint8Array.set 이 가장 빠름
      gray.set(bytes.subarray(srcOff, srcOff + width), dstOff);
    }
  } else {
    const bpp = bitCount >> 3; // 3 or 4
    const rowSize = ((width * bpp + 3) >> 2) << 2;
    const inv3 = 1 / 3;
    for (let y = 0; y < height; y++) {
      const srcY = isTopDown ? y : height - 1 - y;
      const srcOff = offBits + srcY * rowSize;
      const dstOff = y * width;
      for (let x = 0; x < width; x++) {
        const p = srcOff + x * bpp;
        const b = bytes[p];
        const g = bytes[p + 1];
        const r = bytes[p + 2];
        gray[dstOff + x] = ((b + g + r) * inv3) | 0;
      }
    }
  }
  return { width, height, data: gray };
}

export interface RoiDecodeResult {
  imgWidth: number;
  imgHeight: number;
  perRoi: GrayscaleImage[];      // ROI 별로 crop 된 grayscale (length = rois.length)
  bytesRead: number;             // 실제 디스크에서 읽은 byte 수 (헤더 + partial)
}

/**
 * 8-bit / 24-bit / 32-bit uncompressed BMP 에서 ROI 영역만 partial read 로 추출.
 * - 헤더 만 먼저 read 해서 dimensions / offBits 파악
 * - 모든 ROI 의 y 범위 합집합만 partial read
 * - 각 ROI 별로 정확히 그 영역의 grayscale 만들어 반환
 *
 * 지원 안 하는 경우 (PNG/JPG, 압축 BMP, palette 비-identity 가능성) 는 null 반환 →
 * 호출자가 fallback (전체 디코드) 사용.
 */
export async function decodeBmpRoisOnly(
  file: File,
  rois: BestFocusRoi[],
): Promise<RoiDecodeResult | null> {
  if (!/\.bmp$/i.test(file.name)) return null;
  if (rois.length === 0) return null;

  // 헤더 read (8-bit 의 palette 까지 포함하도록 충분히 크게)
  const headerSize = Math.min(2048, file.size);
  const headerBuf = await file.slice(0, headerSize).arrayBuffer();
  const view = new DataView(headerBuf);
  if (view.getUint16(0, true) !== 0x4d42) return null;

  const offBits = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const heightRaw = view.getInt32(22, true);
  const bitCount = view.getUint16(28, true);
  const compression = view.getUint32(30, true);

  if (compression !== 0) return null;
  if (bitCount !== 8 && bitCount !== 24 && bitCount !== 32) return null;

  const isTopDown = heightRaw < 0;
  const height = Math.abs(heightRaw);
  const bpp = bitCount === 8 ? 1 : bitCount >> 3;
  const rowSize = ((width * bpp + 3) >> 2) << 2;

  // ROI y 범위 합집합 (이미지 경계로 clamp 한 값)
  let yMin = height;
  let yMax = 0;
  let valid = false;
  for (const r of rois) {
    const y0 = Math.max(0, r.y);
    const y1 = Math.min(height, r.y + r.height);
    if (y1 > y0) {
      if (y0 < yMin) yMin = y0;
      if (y1 > yMax) yMax = y1;
      valid = true;
    }
  }
  if (!valid) {
    return {
      imgWidth: width,
      imgHeight: height,
      perRoi: rois.map(() => ({ width: 0, height: 0, data: new Uint8Array(0) })),
      bytesRead: headerSize,
    };
  }

  // partial byte range
  let byteStart: number;
  let byteEnd: number;
  if (isTopDown) {
    byteStart = offBits + yMin * rowSize;
    byteEnd = offBits + yMax * rowSize;
  } else {
    byteStart = offBits + (height - yMax) * rowSize;
    byteEnd = offBits + (height - yMin) * rowSize;
  }
  const partialBuf = await file.slice(byteStart, byteEnd).arrayBuffer();
  const bytes = new Uint8Array(partialBuf);

  // ROI 별 grayscale crop
  const perRoi: GrayscaleImage[] = rois.map((r) => {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(width, r.x + r.width);
    const y1 = Math.min(height, r.y + r.height);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 3 || h < 3) return { width: 0, height: 0, data: new Uint8Array(0) };
    const data = new Uint8Array(w * h);
    if (bpp === 1) {
      for (let yy = 0; yy < h; yy++) {
        const imgY = y0 + yy;
        const srcOff = isTopDown
          ? (imgY - yMin) * rowSize
          : (yMax - 1 - imgY) * rowSize;
        data.set(bytes.subarray(srcOff + x0, srcOff + x0 + w), yy * w);
      }
    } else {
      // 24/32 bit BGR(A) → grayscale avg
      const inv3 = 1 / 3;
      for (let yy = 0; yy < h; yy++) {
        const imgY = y0 + yy;
        const srcOff = isTopDown
          ? (imgY - yMin) * rowSize
          : (yMax - 1 - imgY) * rowSize;
        const dstOff = yy * w;
        for (let xx = 0; xx < w; xx++) {
          const p = srcOff + (x0 + xx) * bpp;
          const b = bytes[p];
          const g = bytes[p + 1];
          const r2 = bytes[p + 2];
          data[dstOff + xx] = ((b + g + r2) * inv3) | 0;
        }
      }
    }
    return { width: w, height: h, data };
  });

  return {
    imgWidth: width,
    imgHeight: height,
    perRoi,
    bytesRead: headerSize + (byteEnd - byteStart),
  };
}
