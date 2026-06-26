/// <reference lib="webworker" />
import { decodeImageToGray, decodeBmpRoisOnly } from './etwDecodeGray';
import { calculateEdgeness, type BestFocusRoi } from './etwBestFocus';

export interface MrbfWorkerTask {
  folderIdx: number;
  frameIdx: number;
  file: File;
  rois: BestFocusRoi[];
  mode: number;
}

export interface MrbfWorkerResult {
  folderIdx: number;
  frameIdx: number;
  edgenesses: number[];
  decodeMs: number;
  edgenessMs: number;
  pixels: number;       // 처리한 grayscale 픽셀 (ROI 합)
  bytes: number;        // 실제 read 한 file byte (partial 인 경우 헤더 + partial)
  partial: boolean;     // partial path 적용됐는지
  ok: boolean;
}

self.addEventListener('message', async (e: MessageEvent<MrbfWorkerTask>) => {
  const { folderIdx, frameIdx, file, rois, mode } = e.data;
  const edgenesses = new Array<number>(rois.length).fill(0);
  let decodeMs = 0;
  let edgenessMs = 0;
  let pixels = 0;
  let bytes = 0;
  let partial = false;
  let ok = false;

  try {
    const t1 = performance.now();
    const partialRes = await decodeBmpRoisOnly(file, rois);
    if (partialRes) {
      const t2 = performance.now();
      decodeMs = t2 - t1;
      bytes = partialRes.bytesRead;
      partial = true;
      for (let i = 0; i < rois.length; i++) {
        const g = partialRes.perRoi[i];
        pixels += g.width * g.height;
        if (g.width >= 3 && g.height >= 3) {
          // crop 된 이미지이므로 ROI 좌표는 (0, 0, w, h)
          edgenesses[i] = calculateEdgeness(g, { x: 0, y: 0, width: g.width, height: g.height }, mode);
        }
      }
      const t3 = performance.now();
      edgenessMs = t3 - t2;
      ok = true;
    } else {
      // fallback: 전체 디코드
      const gray = await decodeImageToGray(file);
      const t2 = performance.now();
      decodeMs = t2 - t1;
      bytes = file.size;
      pixels = gray.width * gray.height;
      for (let i = 0; i < rois.length; i++) {
        edgenesses[i] = calculateEdgeness(gray, rois[i], mode);
      }
      const t3 = performance.now();
      edgenessMs = t3 - t2;
      ok = true;
    }
  } catch {
    /* leave defaults */
  }

  const result: MrbfWorkerResult = {
    folderIdx, frameIdx, edgenesses,
    decodeMs, edgenessMs,
    pixels, bytes, partial, ok,
  };
  self.postMessage(result);
});
