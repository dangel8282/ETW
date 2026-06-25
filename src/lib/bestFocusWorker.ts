/// <reference lib="webworker" />
import { decodeImageToGray } from './etwDecodeGray';
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
  ok: boolean;
}

self.addEventListener('message', async (e: MessageEvent<BfWorkerTask>) => {
  const { folderIdx, frameIdx, file, roi, mode } = e.data;
  const t1 = performance.now();
  let edgeness = 0;
  let decodeMs = 0;
  let edgenessMs = 0;
  let ok = false;
  try {
    const gray = await decodeImageToGray(file);
    const t2 = performance.now();
    decodeMs = t2 - t1;
    edgeness = calculateEdgeness(gray, roi, mode);
    const t3 = performance.now();
    edgenessMs = t3 - t2;
    ok = true;
  } catch {
    /* leave defaults */
  }
  const result: BfWorkerResult = { folderIdx, frameIdx, edgeness, decodeMs, edgenessMs, ok };
  self.postMessage(result);
});
