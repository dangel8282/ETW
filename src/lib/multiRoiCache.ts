import type { BestFocusResult } from './etwBestFocus';
import type { NamedRoi } from './multiRoi';

const CACHE_KEY = 'mrbf_cache_v1';
const MAX_ENTRIES = 8;            // 폴더 결과가 더 크니 BF보다 적게

export interface MrbfCachedFolder {
  name: string;
  heightUm: number | null;
  count: number;
  edgenessByRoi: number[][];
  bestByRoi: (BestFocusResult | null)[];
  decodeMs: number;
  edgenessMs: number;
}

export interface MrbfCacheEntry {
  fingerprint: string;
  baseFingerprint: string;
  topFolder: string;
  folderCount: number;
  totalImages: number;
  rois: NamedRoi[];
  mode: number;
  totalMs: number;
  totalPixels: number;
  totalBytes: number;
  partialCount: number;
  fileSizeSum: number;
  timestamp: number;
  results: MrbfCachedFolder[];
}

function readMap(): Record<string, MrbfCacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, MrbfCacheEntry>;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, MrbfCacheEntry>): void {
  try {
    const entries = Object.entries(map);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const trimmed = entries.slice(-MAX_ENTRIES);
      const next: Record<string, MrbfCacheEntry> = {};
      for (const [k, v] of trimmed) next[k] = v;
      localStorage.setItem(CACHE_KEY, JSON.stringify(next));
    } else {
      localStorage.setItem(CACHE_KEY, JSON.stringify(map));
    }
  } catch {
    /* quota — skip */
  }
}

export function makeBaseFingerprint(topFolder: string, folderCount: number, totalImages: number): string {
  return `${topFolder}|f${folderCount}|i${totalImages}`;
}

export function makeFingerprint(
  topFolder: string,
  folderCount: number,
  totalImages: number,
  rois: NamedRoi[],
  mode: number,
): string {
  const base = makeBaseFingerprint(topFolder, folderCount, totalImages);
  // 이름은 fingerprint 에 포함 안 함 (같은 좌표 ROI 이면 동일 캐시 사용 가능)
  const roiStr = rois.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';');
  return `${base}|r${roiStr}|m${mode}`;
}

export function saveCache(entry: MrbfCacheEntry): void {
  const map = readMap();
  map[entry.fingerprint] = entry;
  writeMap(map);
}

/** baseFingerprint 일치 캐시들 중 가장 최근 것 (ROI/mode 무관) */
export function findCacheByBase(base: string): MrbfCacheEntry | null {
  const map = readMap();
  let best: MrbfCacheEntry | null = null;
  for (const e of Object.values(map)) {
    if (e.baseFingerprint !== base) continue;
    if (!best || e.timestamp > best.timestamp) best = e;
  }
  return best;
}

export function findCacheExact(fingerprint: string): MrbfCacheEntry | null {
  const map = readMap();
  return map[fingerprint] ?? null;
}

export function clearAllCache(): void {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* */ }
}
