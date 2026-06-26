/// <reference lib="webworker" />
import { decodeImageToGray, decodeBmpRoisOnly } from './etwDecodeGray';
import { calculateEdgeness, type BestFocusRoi } from './etwBestFocus';

export interface BfWorkerTask {
  folderIdx: number;
  frameIdx: number;
  file: File;
  roi: BestFocusRoi;
  mode: number;
}

export interface BfWorkerResult {
  folderIdx: number;
  frameIdx: number;
  edgeness: number;
  decodeMs: number;
  edgenessMs: number;
  pixels: number;  // 처리한 grayscale 픽셀 (ROI 영역)
  bytes: number;   // 실제 read 한 file byte (partial 인 경우 헤더 + ROI 행만)
  partial: boolean;
  ok: boolean;
}

self.addEventListener('message', async (e: MessageEvent<BfWorkerTask>) => {
  const { folderIdx, frameIdx, file, roi, mode } = e.data;
  const t1 = performance.now();
  let edgeness = 0;
  let decodeMs = 0;
  let edgenessMs = 0;
  let pixels = 0;
  let bytes = 0;
  let partial = false;
  let ok = false;

  try {
    const partialRes = await decodeBmpRoisOnly(file, [roi]);
    if (partialRes) {
      const t2 = performance.now();
      decodeMs = t2 - t1;
      bytes = partialRes.bytesRead;
      partial = true;
      const g = partialRes.perRoi[0];
      pixels = g.width * g.height;
      if (g.width >= 3 && g.height >= 3) {
        // crop 된 이미지이므로 ROI 좌표는 (0, 0, w, h)
        edgeness = calculateEdgeness(g, { x: 0, y: 0, width: g.width, height: g.height }, mode);
      }
      const t3 = performance.now();
      edgenessMs = t3 - t2;
      ok = true;
    } else {
      // fallback: 전체 디코드 (BMP 아니거나 partial 실패)
      const gray = await decodeImageToGray(file);
      const t2 = performance.now();
      decodeMs = t2 - t1;
      bytes = file.size;
      pixels = gray.width * gray.height;
      edgeness = calculateEdgeness(gray, roi, mode);
      const t3 = performance.now();
      edgenessMs = t3 - t2;
      ok = true;
    }
  } catch {
    /* leave defaults */
  }
  const result: BfWorkerResult = {
    folderIdx, frameIdx, edgeness,
    decodeMs, edgenessMs,
    pixels, bytes, partial, ok,
  };
  self.postMessage(result);
});
