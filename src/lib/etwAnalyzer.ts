import type { EtwMeasurementResult, EtwSingleResult } from './etwTypes';
import { emptySingleResult } from './etwTypes';

export interface GrayscaleImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function imageDataToGrayscale(imageData: ImageData): GrayscaleImage {
  const { width, height, data } = imageData;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return { width, height, data: gray };
}

function getGray(img: GrayscaleImage, x: number, y: number): number {
  return img.data[y * img.width + x];
}

function findCrossing(profile: number[], target: number): number {
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    const crossesUp = a <= target && target <= b;
    const crossesDown = b <= target && target <= a;
    if (crossesUp || crossesDown) {
      const denom = b - a;
      if (Math.abs(denom) < 1e-9) return i;
      return i + (target - a) / denom;
    }
  }
  return NaN;
}

function analyzeProfile(profile: number[], lowerTh: number, upperTh: number): EtwSingleResult {
  const r = emptySingleResult();
  if (!profile || profile.length < 4) return r;

  r.profile = profile.slice();
  r.startLevel = profile[0];
  r.endLevel = profile[profile.length - 1];

  let pMin = profile[0];
  let pMax = profile[0];
  for (let i = 1; i < profile.length; i++) {
    if (profile[i] < pMin) pMin = profile[i];
    if (profile[i] > pMax) pMax = profile[i];
  }
  const range = pMax - pMin;
  r.profileMin = pMin;
  r.profileMax = pMax;

  if (range < 1e-3) return r;

  const level10 = pMin + lowerTh * range;
  const level90 = pMin + upperTh * range;
  r.level10 = level10;
  r.level90 = level90;

  r.x10 = findCrossing(profile, level10);
  r.x90 = findCrossing(profile, level90);
  r.distance = Math.abs(r.x90 - r.x10);
  r.isValid = !Number.isNaN(r.x10) && !Number.isNaN(r.x90);
  return r;
}

export interface AnalyzeParams {
  cx: number;
  cy: number;
  width: number;
  height: number;
  lowerTh: number;
  upperTh: number;
  pointId: number;
  pixelWidthUm: number;
  pixelHeightUm: number;
}

export function analyze(image: GrayscaleImage, p: AnalyzeParams): EtwMeasurementResult {
  const result: EtwMeasurementResult = {
    pointId: p.pointId,
    x: p.cx,
    y: p.cy,
    width: p.width,
    height: p.height,
    pixelWidthUm: p.pixelWidthUm,
    pixelHeightUm: p.pixelHeightUm,
    horizontal: emptySingleResult(),
    vertical: emptySingleResult(),
  };

  if (!image || !image.data || image.width <= 0 || image.height <= 0) return result;

  const hLen = Math.max(0, Math.min(p.width, image.width - p.cx));
  if (hLen >= 4 && p.cy >= 0 && p.cy < image.height) {
    const hProfile = new Array<number>(hLen);
    for (let i = 0; i < hLen; i++) {
      const px = p.cx + i;
      hProfile[i] = px < 0 || px >= image.width ? 0 : getGray(image, px, p.cy);
    }
    result.horizontal = analyzeProfile(hProfile, p.lowerTh, p.upperTh);
  }

  const vLen = Math.max(0, Math.min(p.height, image.height - p.cy));
  if (vLen >= 4 && p.cx >= 0 && p.cx < image.width) {
    const vProfile = new Array<number>(vLen);
    for (let i = 0; i < vLen; i++) {
      const py = p.cy + i;
      vProfile[i] = py < 0 || py >= image.height ? 0 : getGray(image, p.cx, py);
    }
    result.vertical = analyzeProfile(vProfile, p.lowerTh, p.upperTh);
  }

  return result;
}
