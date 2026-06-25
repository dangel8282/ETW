import type { BestFocusResult, BestFocusRoi } from './etwBestFocus';

const CACHE_KEY = 'bf_cache_v1';
const MAX_ENTRIES = 16;

export interface CachedFolder {
  name: string;
  heightUm: number | null;
  count: number;
  edgeness: number[];
  best: BestFocusResult | null;
  decodeMs: number;
  edgenessMs: number;
}

export interface CacheEntry {
  fingerprint: string;          // 식별자 (top + count + ROI + mode)
  baseFingerprint: string;      // ROI/mode 제외한 폴더 식별자 (느슨한 검색)
  topFolder: string;
  folderCount: number;
  totalImages: number;
  roi: BestFocusRoi;
  mode: number;
  totalMs: number;
  pixelCount: number;
  timestamp: number;            // ms
  results: CachedFolder[];
}

function readMap(): Record<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, CacheEntry>): void {
  try {
    // entries가 너무 많아지면 오래된 것 제거
    const entries = Object.entries(map);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const trimmed = entries.slice(-MAX_ENTRIES);
      const next: Record<string, CacheEntry> = {};
      for (const [k, v] of trimmed) next[k] = v;
      localStorage.setItem(CACHE_KEY, JSON.stringify(next));
    } else {
      localStorage.setItem(CACHE_KEY, JSON.stringify(map));
    }
  } catch {
    /* quota — skip */
  }
}

export function makeBaseFingerprint(
  topFolder: string,
  folderCount: number,
  totalImages: number,
): string {
  return `${topFolder}|f${folderCount}|i${totalImages}`;
}

export function makeFingerprint(
  topFolder: string,
  folderCount: number,
  totalImages: number,
  roi: BestFocusRoi,
  mode: number,
): string {
  const base = makeBaseFingerprint(topFolder, folderCount, totalImages);
  return `${base}|r${roi.x},${roi.y},${roi.width},${roi.height}|m${mode}`;
}

export function saveCache(entry: CacheEntry): void {
  const map = readMap();
  map[entry.fingerprint] = entry;
  writeMap(map);
}

/** baseFingerprint (폴더 식별) 일치하는 캐시들 중 가장 최근 것 반환 */
export function findCacheByBase(base: string): CacheEntry | null {
  const map = readMap();
  let best: CacheEntry | null = null;
  for (const e of Object.values(map)) {
    if (e.baseFingerprint !== base) continue;
    if (!best || e.timestamp > best.timestamp) best = e;
  }
  return best;
}

/** 정확히 일치하는 캐시 반환 (ROI/mode까지) */
export function findCacheExact(fingerprint: string): CacheEntry | null {
  const map = readMap();
  return map[fingerprint] ?? null;
}

export function clearAllCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch { /* */ }
}
