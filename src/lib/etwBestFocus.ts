import type { GrayscaleImage } from './etwAnalyzer';

export interface BestFocusRoi {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Edgeness 4 modes (WSA OSA Edgeness.cs 와 동일):
 *  0: Σ (|∂x| + |∂y|)²   Sobel-like + square
 *  2: Σ (|∂x| + |∂y|)    Sobel-like + linear
 *  1: Σ |9·center − Σ3×3|²  Laplacian-like + square
 *  3: Σ |9·center − Σ3×3|   Laplacian-like + linear
 *
 * ROI 가장자리 1px 안쪽까지 (3×3 stencil 필요).
 * grayscale 8-bit, stride = width.
 */
export function calculateEdgeness(
  img: GrayscaleImage,
  roi: BestFocusRoi,
  mode: number,
): number {
  if (!img || !img.data) return 0;
  const x0 = Math.max(0, roi.x);
  const y0 = Math.max(0, roi.y);
  const x1 = Math.min(img.width, roi.x + roi.width);
  const y1 = Math.min(img.height, roi.y + roi.height);
  if (x1 - x0 < 3 || y1 - y0 < 3) return 0;

  const data = img.data;
  const stride = img.width;
  let sum = 0;

  if ((mode & 1) === 0) {
    // ── Sobel-like ──
    for (let i = y0 + 1; i < y1 - 1; i++) {
      const rowM1 = (i - 1) * stride;
      const row0 = i * stride;
      const rowP1 = (i + 1) * stride;
      for (let j = x0 + 1; j < x1 - 1; j++) {
        let gx = 0;
        let gy = 0;
        // m = -1
        gx += Math.abs(data[rowM1 + j + 1] - data[rowM1 + j - 1]);
        gy += Math.abs(data[rowP1 + j - 1] - data[rowM1 + j - 1]);
        // m = 0
        gx += Math.abs(data[row0 + j + 1] - data[row0 + j - 1]);
        gy += Math.abs(data[rowP1 + j] - data[rowM1 + j]);
        // m = 1
        gx += Math.abs(data[rowP1 + j + 1] - data[rowP1 + j - 1]);
        gy += Math.abs(data[rowP1 + j + 1] - data[rowM1 + j + 1]);
        const v = gx + gy;
        sum += mode === 0 ? v * v : v;
      }
    }
  } else {
    // ── Laplacian-like ──
    for (let i = y0 + 1; i < y1 - 1; i++) {
      const rowM1 = (i - 1) * stride;
      const row0 = i * stride;
      const rowP1 = (i + 1) * stride;
      for (let j = x0 + 1; j < x1 - 1; j++) {
        const s =
          data[rowM1 + j - 1] + data[rowM1 + j] + data[rowM1 + j + 1] +
          data[row0 + j - 1]  + data[row0 + j]  + data[row0 + j + 1] +
          data[rowP1 + j - 1] + data[rowP1 + j] + data[rowP1 + j + 1];
        const v = Math.abs(data[row0 + j] * 9 - s);
        sum += mode === 1 ? v * v : v;
      }
    }
  }
  return sum;
}

/**
 * 3-point parabolic fit으로 sub-step Δ ∈ [-0.5, +0.5] 산출.
 * - bestIdx 가 경계 (0 또는 끝) → 0
 * - denom 이 epsilon 미만 → 0 (분모 가드)
 */
export function computeSubStep(F: number[], bestIdx: number, epsilon = 1e-6): number {
  if (bestIdx < 1 || bestIdx + 1 >= F.length) return 0;
  const fm1 = F[bestIdx - 1];
  const f0 = F[bestIdx];
  const fp1 = F[bestIdx + 1];
  const denom = fm1 - 2 * f0 + fp1;
  if (Math.abs(denom) < epsilon) return 0;
  let delta = (0.5 * (fm1 - fp1)) / denom;
  if (delta < -0.5) delta = -0.5;
  if (delta > 0.5) delta = 0.5;
  return delta;
}

export interface BestFocusResult {
  bestFrameIdxRaw: number;   // integer argmax
  bestFrameIdx: number;      // sub-frame interp
  bestStepValue: number;     // stepList 보간값 (없으면 = bestFrameIdx)
  maxEdgeness: number;
}

export function findBestFocus(
  edgeness: number[],
  stepList?: number[],
  epsilon = 1e-6,
): BestFocusResult {
  let bestIdx = 0;
  let bestVal = -Infinity;
  for (let n = 0; n < edgeness.length; n++) {
    if (edgeness[n] > bestVal) {
      bestVal = edgeness[n];
      bestIdx = n;
    }
  }
  const delta = computeSubStep(edgeness, bestIdx, epsilon);
  let fracIdx = bestIdx + delta;
  if (fracIdx < 0) fracIdx = 0;
  if (fracIdx > edgeness.length - 1) fracIdx = edgeness.length - 1;

  let stepValue = fracIdx;
  if (stepList && stepList.length === edgeness.length && edgeness.length >= 2) {
    const floor = Math.floor(fracIdx);
    if (floor >= edgeness.length - 1) {
      stepValue = stepList[edgeness.length - 1];
    } else {
      const w = fracIdx - floor;
      stepValue = (1 - w) * stepList[floor] + w * stepList[floor + 1];
    }
  }

  return {
    bestFrameIdxRaw: bestIdx,
    bestFrameIdx: fracIdx,
    bestStepValue: stepValue,
    maxEdgeness: bestVal,
  };
}
