import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ScatterChart,
  Scatter,
} from 'recharts';
import { findBestFocus, type BestFocusRoi, type BestFocusResult } from '../lib/etwBestFocus';
import BestFocusWorker from '../lib/bestFocusWorker.ts?worker';
import type { BfWorkerResult, BfWorkerTask } from '../lib/bestFocusWorker';
import {
  findCacheByBase,
  findCacheExact,
  findRecentFullMs,
  makeBaseFingerprint,
  makeFingerprint,
  saveCache,
  type CacheEntry,
} from '../lib/bestFocusCache';
import { decodeImageToGray } from '../lib/etwDecodeGray';
import { EtwBatchTrendChart } from './EtwBatchTrendChart';
import { analyze } from '../lib/etwAnalyzer';
import { buildBatchEtwCsv, downloadCsv, type BatchEtwCsvRow } from '../lib/etwCsv';
import type { EtwMeasurementPoint, EtwMeasurementResult } from '../lib/etwTypes';
import { BestFocusRoiEditor } from './BestFocusRoiEditor';

const MODE_LABELS: Record<number, string> = {
  0: '0 — Sobel²',
  2: '2 — Sobel',
  1: '1 — Laplacian²',
  3: '3 — Laplacian',
};

const IMAGE_EXT_RE = /\.(bmp|png|jpe?g|tiff?|gif|webp)$/i;
const naturalSort = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

interface FolderInput {
  name: string;
  files: File[];
}
interface FolderResult {
  name: string;
  heightUm: number | null;
  count: number;
  edgeness: number[];
  best: BestFocusResult | null;
  decodeMs: number;
  edgenessMs: number;
}

interface RunMetrics {
  totalMs: number;
  decodeMs: number;       // 누적
  edgenessMs: number;     // 누적
  totalImages: number;
  totalPixels: number;    // ROI 픽셀 합
  totalBytes: number;     // 실제 read 한 byte (partial 시 헤더+ROI 행)
  partialCount: number;
  fileSizeSum: number;    // 원본 파일 사이즈 합
}

function parseHeightUm(name: string): number | null {
  const m = name.match(/(-?\d+(?:\.\d+)?)\s*um/i);
  return m ? parseFloat(m[1]) : null;
}

/** webkitRelativePath 로 서브폴더별로 그룹화. 최상위 폴더에 직접 있는 파일은 제외. */
function groupByFolder(filelist: FileList): FolderInput[] {
  const groups = new Map<string, File[]>();
  for (const f of Array.from(filelist)) {
    if (!IMAGE_EXT_RE.test(f.name)) continue;
    // webkitRelativePath 예: "20260625.../39100um/I0-0.BMP"
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const parts = path.split('/');
    // depth < 3 (= 최상위 폴더 직속 파일) 은 무시 — 서브폴더만 처리.
    if (parts.length < 3) continue;
    const folderName = parts[parts.length - 2];
    if (!groups.has(folderName)) groups.set(folderName, []);
    groups.get(folderName)!.push(f);
  }
  const out: FolderInput[] = [];
  for (const [name, files] of groups) {
    files.sort((a, b) => naturalSort(a.name, b.name));
    out.push({ name, files });
  }
  out.sort((a, b) => naturalSort(a.name, b.name));
  return out;
}

const N_WORKERS = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const STORAGE_KEY_LAST_NAME = 'bf_last_folder_name';
const STORAGE_KEY_LAST_INFO = 'bf_last_folder_info';

// 모드 전환 시 폴더 / 선택 상태 유지를 위한 module-level cache
const sessionCache: {
  folders: FolderInput[];
  selectedFolderIdx: number;
} = {
  folders: [],
  selectedFolderIdx: 0,
};

function colorForFolder(idx: number, total: number): string {
  if (total <= 1) return '#2563eb';
  const hue = (idx / Math.max(1, total - 1)) * 280; // 0=red → 280=purple
  return `hsl(${hue.toFixed(0)}, 65%, 45%)`;
}

interface BestFocusTestProps {
  onClose: () => void;
  points: EtwMeasurementPoint[];
  roiWidth: number;
  roiHeight: number;
  lowerThPercent: number;
  upperThPercent: number;
  pixelWidthUm: number;
  pixelHeightUm: number;
}

export function BestFocusTest({
  onClose,
  points,
  roiWidth: etwRoiWidth,
  roiHeight: etwRoiHeight,
  lowerThPercent,
  upperThPercent,
  pixelWidthUm,
  pixelHeightUm,
}: BestFocusTestProps) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const workersRef = useRef<Worker[]>([]);

  const [folders, setFolders] = useState<FolderInput[]>(sessionCache.folders);
  const [results, setResults] = useState<FolderResult[]>([]);
  const [selectedFolderIdx, setSelectedFolderIdx] = useState<number>(sessionCache.selectedFolderIdx);
  const [visibleSet, setVisibleSet] = useState<Set<number>>(new Set());

  const [roi, setRoi] = useState<BestFocusRoi>(() => {
    try {
      const raw = localStorage.getItem('bf_last_roi');
      if (raw) {
        const v = JSON.parse(raw);
        if (
          typeof v?.x === 'number' && typeof v?.y === 'number' &&
          typeof v?.width === 'number' && typeof v?.height === 'number'
        ) return v;
      }
    } catch { /* ignore */ }
    return { x: 1000, y: 1000, width: 256, height: 256 };
  });
  const [mode, setMode] = useState<number>(() => {
    const raw = localStorage.getItem('bf_last_mode');
    const v = raw == null ? NaN : parseInt(raw, 10);
    return [0, 1, 2, 3].includes(v) ? v : 0;
  });

  // ROI / mode 변경 시 자동 저장 — debounce 500ms (드래그/리사이즈 매 frame 부담 방지)
  useEffect(() => {
    const t = window.setTimeout(() => {
      try { localStorage.setItem('bf_last_roi', JSON.stringify(roi)); } catch { /* */ }
    }, 500);
    return () => window.clearTimeout(t);
  }, [roi]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      try { localStorage.setItem('bf_last_mode', String(mode)); } catch { /* */ }
    }, 500);
    return () => window.clearTimeout(t);
  }, [mode]);

  const [running, setRunning] = useState<boolean>(false);
  const [progress, setProgress] = useState<{ done: number; total: number; folderDone: number; folderTotal: number } | null>(null);
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  // 같은 폴더 set 의 이전 full-decode 시간 (자동 비교 표시용). cache 에 partial 없는 entry → 그게 full 추정.
  const [previousFullMs, setPreviousFullMs] = useState<number | null>(null);
  const [status, setStatus] = useState<string>(
    sessionCache.folders.length > 0
      ? `${sessionCache.folders.length} folder(s) restored — pick to refresh`
      : 'Pick a parent folder',
  );

  // session cache sync — 모드 전환 후 복귀 시 복원
  useEffect(() => { sessionCache.folders = folders; }, [folders]);
  useEffect(() => { sessionCache.selectedFolderIdx = selectedFolderIdx; }, [selectedFolderIdx]);

  // 폴더가 cache 에서 복원된 경우 — 캐시된 결과 자동 조회/적용
  useEffect(() => {
    if (folders.length === 0 || results.length > 0) return;
    const totalImgs = folders.reduce((a, g) => a + g.files.length, 0);
    const firstPath = (folders[0].files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const topFolder = firstPath.split('/')[0] || '';
    const exactFp = makeFingerprint(topFolder, folders.length, totalImgs, roi, mode);
    let cache = findCacheExact(exactFp);
    let exactRoiMatch = true;
    if (!cache) {
      const baseFp = makeBaseFingerprint(topFolder, folders.length, totalImgs);
      cache = findCacheByBase(baseFp);
      exactRoiMatch = false;
    }
    if (cache) applyCache(cache, folders, exactRoiMatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [lastFolderLabel, setLastFolderLabel] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY_LAST_NAME) || null,
  );
  const [lastFolderInfo, setLastFolderInfo] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY_LAST_INFO) || null,
  );

  function onPickFolder(filelist: FileList | null) {
    if (!filelist || filelist.length === 0) return;
    const groups = groupByFolder(filelist);
    if (groups.length === 0) {
      setStatus('No supported images found');
      return;
    }
    const totalImgs = groups.reduce((a, g) => a + g.files.length, 0);
    // 첫 file의 webkitRelativePath에서 top folder 추출
    const firstPath =
      (filelist[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const topFolder = firstPath.split('/')[0] || '';
    const info = `${groups.length} folders · ${totalImgs} images`;
    setLastFolderLabel(topFolder);
    setLastFolderInfo(info);
    try { localStorage.setItem(STORAGE_KEY_LAST_NAME, topFolder); } catch { /* */ }
    try { localStorage.setItem(STORAGE_KEY_LAST_INFO, info); } catch { /* */ }

    setFolders(groups);
    setSelectedFolderIdx(0);
    setVisibleSet(new Set(groups.map((_, i) => i)));

    // 1순위: ROI/mode까지 정확 일치하는 캐시
    const exactFp = makeFingerprint(topFolder, groups.length, totalImgs, roi, mode);
    let cache = findCacheExact(exactFp);

    // 2순위: 같은 폴더 set 이면 가장 최근 캐시 (ROI/mode 무관)
    let exactRoiMatch = true;
    if (!cache) {
      const baseFp = makeBaseFingerprint(topFolder, groups.length, totalImgs);
      cache = findCacheByBase(baseFp);
      exactRoiMatch = false;
    }

    if (cache) {
      applyCache(cache, groups, exactRoiMatch);
    } else {
      setResults([]);
      setMetrics(null);
      setStatus(`${groups.length} folder(s), ${totalImgs} images`);
    }
    // 자동 비교용: 같은 폴더 set 의 가장 최근 full-decode (partialCount === 0) 시간 찾기
    setPreviousFullMs(findRecentFullMs(topFolder, groups.length, totalImgs));
  }

  function applyCache(cache: CacheEntry, groups: FolderInput[], exactRoiMatch: boolean) {
    // groups 순서대로 cache.results 정렬 (이름 매칭)
    const byName = new Map(cache.results.map((r) => [r.name, r]));
    const aligned = groups.map((g) => {
      const c = byName.get(g.name);
      return c
        ? { ...c }
        : ({
            name: g.name,
            heightUm: parseHeightUm(g.name),
            count: g.files.length,
            edgeness: new Array(g.files.length).fill(0),
            best: null,
            decodeMs: 0,
            edgenessMs: 0,
          } as FolderResult);
    });
    setResults(aligned);
    setMetrics({
      totalMs: cache.totalMs,
      decodeMs: 0,
      edgenessMs: 0,
      totalImages: cache.totalImages,
      totalPixels: cache.totalPixels ?? 0,
      totalBytes: cache.totalBytes ?? 0,
      partialCount: cache.partialCount ?? 0,
      fileSizeSum: cache.fileSizeSum ?? 0,
    });
    if (exactRoiMatch) {
      const at = new Date(cache.timestamp).toLocaleString();
      setStatus(`Loaded cached result from ${at}`);
    } else {
      setRoi(cache.roi);
      setMode(cache.mode);
      const at = new Date(cache.timestamp).toLocaleString();
      setStatus(`Loaded cached result from ${at} (ROI/mode restored)`);
    }
  }

  async function onRun() {
    if (folders.length === 0 || running) return;
    setRunning(true);
    setResults([]);
    setMetrics(null);
    setBatchRows(null);

    const folderTotal = folders.length;
    const totalTasks = folders.reduce((s, f) => s + f.files.length, 0);

    // 결과 컨테이너를 미리 생성 (UI가 빈 폴더 리스트 보여줄 수 있게)
    const folderResults: FolderResult[] = folders.map((f) => ({
      name: f.name,
      heightUm: parseHeightUm(f.name),
      count: f.files.length,
      edgeness: new Array(f.files.length).fill(0),
      best: null,
      decodeMs: 0,
      edgenessMs: 0,
    }));
    setResults(folderResults.map((r) => ({ ...r, edgeness: r.edgeness.slice() })));

    // 폴더별 완료 카운터 (모두 끝나면 findBestFocus 호출)
    const folderCompleted = new Array(folderTotal).fill(0);

    // 작업 큐 (flat)
    const tasks: { folderIdx: number; frameIdx: number; file: File }[] = [];
    folders.forEach((folder, folderIdx) => {
      folder.files.forEach((file, frameIdx) => {
        tasks.push({ folderIdx, frameIdx, file });
      });
    });

    // 워커 풀
    const workers: Worker[] = Array.from({ length: N_WORKERS }, () => new BestFocusWorker());
    workersRef.current = workers;

    let nextTaskIdx = 0;
    let completedTasks = 0;
    let foldersDone = 0;
    let aggDecodeMs = 0;
    let aggEdgeMs = 0;
    let aggPixels = 0;
    let aggBytes = 0;
    let aggPartial = 0;
    let aggFileSize = 0;
    const tAll = performance.now();

    await new Promise<void>((resolve) => {
      let resolved = false;
      const cleanup = (cancelled: boolean) => {
        if (resolved) return;
        resolved = true;
        for (const w of workers) w.terminate();
        workersRef.current = [];
        cleanupRef.current = null;
        const tEnd = performance.now();
        const totalMs = tEnd - tAll;
        setMetrics({
          totalMs,
          decodeMs: aggDecodeMs,
          edgenessMs: aggEdgeMs,
          totalImages: completedTasks,
          totalPixels: aggPixels,
          totalBytes: aggBytes,
          partialCount: aggPartial,
          fileSizeSum: aggFileSize,
        });
        setProgress(null);
        setRunning(false);
        if (cancelled) {
          setStatus(`Cancelled — ${foldersDone}/${folderTotal} folders done`);
        } else {
          const partialPct = aggPartial > 0 && completedTasks > 0
            ? ` · ${((aggPartial / completedTasks) * 100).toFixed(0)}% partial`
            : '';
          setStatus(`Done: ${folderTotal} folders in ${(totalMs / 1000).toFixed(2)}s (${N_WORKERS} workers${partialPct})`);
          // 결과 캐시 (cancel 안 됐을 때만)
          try {
            const firstPath = (folders[0]?.files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
            const topFolder = firstPath.split('/')[0] || '';
            const totalImgs = folders.reduce((s, f) => s + f.files.length, 0);
            const baseFp = makeBaseFingerprint(topFolder, folders.length, totalImgs);
            const fp = makeFingerprint(topFolder, folders.length, totalImgs, roi, mode);
            const entry: CacheEntry = {
              fingerprint: fp,
              baseFingerprint: baseFp,
              topFolder,
              folderCount: folders.length,
              totalImages: totalImgs,
              roi,
              mode,
              totalMs,
              pixelCount: aggPixels,
              totalPixels: aggPixels,
              totalBytes: aggBytes,
              partialCount: aggPartial,
              fileSizeSum: aggFileSize,
              timestamp: Date.now(),
              results: folderResults.map((r) => ({
                name: r.name,
                heightUm: r.heightUm,
                count: r.count,
                edgeness: r.edgeness.slice(),
                best: r.best,
                decodeMs: r.decodeMs,
                edgenessMs: r.edgenessMs,
              })),
            };
            saveCache(entry);
          } catch (err) {
            console.warn('Failed to cache result', err);
          }
        }
        // 마지막 결과 sync
        setResults(folderResults.map((r) => ({ ...r, edgeness: r.edgeness.slice() })));
        resolve();
      };
      cleanupRef.current = () => cleanup(true);

      function assignNext(worker: Worker) {
        if (nextTaskIdx >= tasks.length) return;
        const task = tasks[nextTaskIdx++];
        const msg: BfWorkerTask = {
          folderIdx: task.folderIdx,
          frameIdx: task.frameIdx,
          file: task.file,
          roi,
          mode,
        };
        worker.postMessage(msg);
      }

      for (const worker of workers) {
        worker.onmessage = (e: MessageEvent<BfWorkerResult>) => {
          if (resolved) return;
          const { folderIdx, frameIdx, edgeness, decodeMs, edgenessMs, pixels, bytes, partial } = e.data;
          const r = folderResults[folderIdx];
          r.edgeness[frameIdx] = edgeness;
          r.decodeMs += decodeMs;
          r.edgenessMs += edgenessMs;
          aggDecodeMs += decodeMs;
          aggEdgeMs += edgenessMs;
          aggPixels += pixels;
          aggBytes += bytes;
          if (partial) aggPartial++;
          aggFileSize += folders[folderIdx].files[frameIdx].size;
          folderCompleted[folderIdx]++;
          completedTasks++;

          // 폴더 완료 → findBestFocus 즉시
          if (folderCompleted[folderIdx] === folders[folderIdx].files.length) {
            r.best = findBestFocus(r.edgeness);
            foldersDone++;
          }

          // 진행률/UI 업데이트 throttle
          if ((completedTasks & 31) === 0 || completedTasks === totalTasks) {
            setProgress({ done: completedTasks, total: totalTasks, folderDone: foldersDone, folderTotal });
            setResults(folderResults.map((r) => ({ ...r, edgeness: r.edgeness.slice() })));
          }

          // 다음 작업 또는 종료
          if (nextTaskIdx < tasks.length) {
            assignNext(worker);
          } else if (completedTasks === totalTasks) {
            cleanup(false);
          }
        };
        worker.onerror = (err) => {
          console.error('Worker error', err);
        };
      }

      // 초기 작업 분배 — 워커마다 1개씩 (이후로는 message handler 안에서 chain)
      for (const w of workers) assignNext(w);
    });
  }

  function onCancel() {
    cleanupRef.current?.();
  }

  const setRoiField = (key: keyof BestFocusRoi, v: number) =>
    setRoi((r) => ({ ...r, [key]: Math.max(0, Math.round(v)) }));

  const [savingCsv, setSavingCsv] = useState<boolean>(false);
  // batch ETW 결과 — Save ETW CSV 후 메모리에 보관해 트렌드 차트에 사용
  const [batchRows, setBatchRows] = useState<BatchEtwCsvRow[] | null>(null);
  const [previewBitmap, setPreviewBitmap] = useState<ImageBitmap | null>(null);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [editorWidth, setEditorWidth] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem('bf_editor_width') || '', 10);
    return Number.isFinite(saved) && saved >= 280 && saved <= 1200 ? saved : 420;
  });
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 첫 폴더의 첫 이미지로 미리보기 로드 — ROI editor에 표시
  useEffect(() => {
    if (folders.length === 0 || !folders[0].files[0]) {
      setPreviewBitmap((prev) => {
        prev?.close?.();
        return null;
      });
      setPreviewName(null);
      return;
    }
    let aborted = false;
    const file = folders[0].files[0];
    createImageBitmap(file)
      .then((bitmap) => {
        if (aborted) {
          bitmap.close?.();
          return;
        }
        setPreviewBitmap((prev) => {
          prev?.close?.();
          return bitmap;
        });
        setPreviewName(file.name);
      })
      .catch((e) => console.warn('Preview load failed', e));
    return () => {
      aborted = true;
    };
  }, [folders]);

  async function onSaveEtwCsv() {
    if (points.length === 0 || results.length === 0 || savingCsv) return;
    const completed = results.filter((r) => r.best);
    if (completed.length === 0) {
      setStatus('No best-focus results to export');
      return;
    }
    setSavingCsv(true);
    setStatus(`Decoding best-focus image of ${completed.length} folders…`);

    const lowerTh = lowerThPercent / 100;
    const upperTh = upperThPercent / 100;
    const batchRows: BatchEtwCsvRow[] = [];
    let failed = 0;

    for (let i = 0; i < results.length; i++) {
      if (!visibleSet.has(i)) continue;
      const r = results[i];
      const folder = folders[i];
      if (!r?.best || !folder) continue;
      const bestIdx = Math.max(0, Math.min(folder.files.length - 1, Math.round(r.best.bestFrameIdx)));
      const bestFile = folder.files[bestIdx];
      if (!bestFile) continue;
      try {
        const gray = await decodeImageToGray(bestFile);
        const etwResults: EtwMeasurementResult[] = points.map((p) =>
          analyze(gray, {
            cx: p.x,
            cy: p.y,
            width: etwRoiWidth,
            height: etwRoiHeight,
            lowerTh,
            upperTh,
            pointId: p.id,
            pixelWidthUm,
            pixelHeightUm,
          }),
        );
        batchRows.push({
          folderName: r.name,
          heightUm: r.heightUm,
          bestFrameRaw: r.best.bestFrameIdxRaw,
          bestFrameSub: r.best.bestFrameIdx,
          bestImageName: bestFile.name,
          results: etwResults,
        });
      } catch (e) {
        failed++;
        console.warn(`Failed to ETW-analyze ${r.name}`, e);
      }
    }

    if (batchRows.length === 0) {
      setSavingCsv(false);
      setStatus('No data could be exported');
      return;
    }

    const csv = buildBatchEtwCsv(batchRows, lowerThPercent, upperThPercent);
    downloadCsv(`etw_batch_${batchRows.length}_folders.csv`, csv);
    setBatchRows(batchRows);
    setSavingCsv(false);
    setStatus(
      `CSV: ${batchRows.length} folders × ${points.length} points` +
        (failed > 0 ? ` (${failed} folders failed)` : ''),
    );
  }

  const selected = results[selectedFolderIdx];

  // 모든 visible 폴더의 edgeness를 한 차트에 overlay 하기 위해 데이터 병합.
  // 각 row: { i, f0: ..., f1: ..., ... }. Recharts가 dataKey 별로 라인 그림.
  const mergedChartData = useMemo(() => {
    if (results.length === 0 || folders.length === 0) return [];
    const maxFrames = Math.max(...folders.map((f) => f.files.length));
    const out: Array<{ i: number } & Record<string, number | null>> = [];
    for (let i = 0; i < maxFrames; i++) {
      const row: { i: number } & Record<string, number | null> = { i };
      for (let f = 0; f < results.length; f++) {
        if (!visibleSet.has(f)) continue;
        const arr = results[f].edgeness;
        row[`f${f}`] = i < arr.length ? arr[i] : null;
      }
      out.push(row);
    }
    return out;
  }, [results, folders, visibleSet]);

  const xMax = useMemo(
    () => Math.max(1, ...folders.map((f) => f.files.length)) - 1,
    [folders],
  );

  // 화살표 키로 폴더 리스트 선택 변경 (스크롤 대신).
  // input/textarea/select 에 focus 가 있으면 무시.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) return;
      if (results.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        let next: number;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = results.length - 1;
        else next = Math.max(0, Math.min(results.length - 1, selectedFolderIdx + dir));
        if (next !== selectedFolderIdx && results[next]?.best) {
          e.preventDefault();
          setSelectedFolderIdx(next);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedFolderIdx, results]);

  // 선택된 행이 항상 보이도록 자동 스크롤
  const activeRowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedFolderIdx]);

  const toggleVisible = (idx: number) => {
    setVisibleSet((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };
  const setAllVisible = (visible: boolean) => {
    if (visible) setVisibleSet(new Set(folders.map((_, i) => i)));
    else setVisibleSet(new Set());
  };

  // 높이 vs best frame
  const heightChartData = useMemo(() => {
    return results
      .filter((r) => r.best !== null && r.heightUm !== null)
      .map((r) => ({ height: r.heightUm!, best: r.best!.bestFrameIdx, name: r.name }));
  }, [results]);

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex items-center justify-between border-b border-slate-300 bg-white px-4 py-2 shadow-sm">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100">
            ← Back to ETW
          </button>
          <div className="text-base font-bold text-slate-800">Best Focus Test (batch)</div>
        </div>
        <div className="truncate text-xs text-slate-600">{status}</div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: controls + folder list */}
        <aside className="flex w-[300px] flex-col gap-3 overflow-y-auto border-r border-slate-300 bg-slate-50 p-3">
          <div className="rounded border border-slate-200 bg-white p-3">
            <button
              onClick={() => folderInputRef.current?.click()}
              disabled={running}
              className="w-full rounded bg-slate-700 px-2 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
            >
              Pick folder…
            </button>
            {lastFolderLabel && (
              <div className="mt-2 truncate text-[10px] text-slate-600" title={lastFolderLabel}>
                <span className="text-slate-400">현재: </span>
                <span className="font-medium text-slate-700">{lastFolderLabel}</span>
              </div>
            )}
            <div className="mt-1 text-[10px] text-slate-500">
              {folders.length} folders · {folders.reduce((a, g) => a + g.files.length, 0)} images
              {lastFolderInfo && folders.length === 0 && ` · last: ${lastFolderInfo}`}
            </div>
          </div>

          <div className="rounded border border-slate-200 bg-white p-3">
            <div className="mb-2 text-xs font-semibold text-slate-700">ROI (px)</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {(['x', 'y', 'width', 'height'] as const).map((k) => (
                <label key={k} className="flex items-center justify-between gap-1.5 text-xs">
                  <span className="text-slate-600">{k === 'width' ? 'w' : k === 'height' ? 'h' : k}</span>
                  <input
                    type="number"
                    value={roi[k]}
                    onChange={(e) => setRoiField(k, Number(e.target.value))}
                    className="w-20 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-right text-xs"
                    disabled={running}
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="rounded border border-slate-200 bg-white p-3">
            <div className="mb-2 text-xs font-semibold text-slate-700">Edgeness mode</div>
            <select
              value={mode}
              onChange={(e) => setMode(Number(e.target.value))}
              disabled={running}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              {[0, 2, 1, 3].map((m) => (
                <option key={m} value={m}>{MODE_LABELS[m]}</option>
              ))}
            </select>
          </div>

          {progress ? (
            <div className="rounded border border-slate-200 bg-white p-3">
              <div className="mb-1 flex justify-between text-xs text-slate-700">
                <span>Folders {progress.folderDone}/{progress.folderTotal}</span>
                <span className="font-mono">{progress.done}/{progress.total}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded bg-slate-200">
                <div
                  className="h-full bg-cyan-500 transition-all"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              <div className="mt-1 text-[10px] text-slate-500">
                {N_WORKERS} workers · {((progress.done / progress.total) * 100).toFixed(1)}%
              </div>
              <button className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" onClick={onCancel}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              className="w-full rounded bg-emerald-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
              disabled={folders.length === 0 || running}
              onClick={onRun}
            >
              Run Best Focus
            </button>
          )}

          <div className="rounded border border-cyan-200 bg-cyan-50 p-3 text-xs">
            <div className="mb-1 font-semibold text-slate-700">ETW points (from main view)</div>
            {points.length === 0 ? (
              <div className="mt-1 text-slate-500">
                No points registered.
                <button onClick={onClose} className="ml-1 text-cyan-700 underline hover:text-cyan-900">
                  Register in ETW →
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-[110px_1fr] gap-y-0.5">
                  <span className="text-slate-500">Points</span>
                  <span className="font-mono">{points.length}</span>
                  <span className="text-slate-500">ETW ROI</span>
                  <span className="font-mono">{etwRoiWidth}×{etwRoiHeight} px</span>
                  <span className="text-slate-500">Threshold</span>
                  <span className="font-mono">{Math.round(lowerThPercent)}% / {Math.round(upperThPercent)}%</span>
                  <span className="text-slate-500">Pixel size</span>
                  <span className="font-mono">{pixelWidthUm.toFixed(3)} / {pixelHeightUm.toFixed(3)} µm</span>
                </div>
                {(() => {
                  const eligible = results.filter((r, i) => r.best && visibleSet.has(i)).length;
                  const disabled = savingCsv || running || eligible === 0;
                  return (
                    <button
                      className="mt-2 w-full rounded bg-cyan-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-40"
                      disabled={disabled}
                      onClick={onSaveEtwCsv}
                      title={
                        eligible === 0
                          ? 'No checked folders with best focus result'
                          : `Decode ${eligible} best-focus images and analyze ETW`
                      }
                    >
                      {savingCsv ? 'Saving CSV…' : `Save ETW CSV (${eligible})`}
                    </button>
                  );
                })()}
              </>
            )}
          </div>

          {metrics && results.length > 0 && (
            <div className="rounded border border-slate-200 bg-white p-3 text-xs">
              <div className="mb-1 font-semibold text-slate-700">Speed</div>
              <div className="grid grid-cols-[110px_1fr] gap-y-0.5">
                <span className="text-slate-500">Total</span>
                <span className="font-mono">{(metrics.totalMs / 1000).toFixed(2)} s</span>
                <span className="text-slate-500">Per folder</span>
                <span className="font-mono">{(metrics.totalMs / Math.max(1, results.length)).toFixed(0)} ms</span>
                <span className="text-slate-500">Per image</span>
                <span className="font-mono">{(metrics.totalMs / Math.max(1, metrics.totalImages)).toFixed(1)} ms</span>
                <span className="text-slate-500">Throughput</span>
                <span className="font-mono">
                  {(metrics.totalImages / (metrics.totalMs / 1000)).toFixed(1)} img/s
                </span>
                <span className="text-slate-500">Decode</span>
                <span className="font-mono" title="Aggregated across workers">
                  {(metrics.decodeMs / Math.max(1, metrics.totalImages)).toFixed(1)} ms/img
                </span>
                <span className="text-slate-500">Edgeness</span>
                <span className="font-mono">
                  {(metrics.edgenessMs / Math.max(1, metrics.totalImages)).toFixed(2)} ms/img
                </span>
                <span className="text-slate-500">Pixels read</span>
                <span className="font-mono">
                  {(metrics.totalPixels / 1e6).toFixed(2)} Mpx
                </span>
                <span className="text-slate-500">Data read</span>
                <span className="font-mono">
                  {(metrics.totalBytes / 1e9).toFixed(2)} GB
                  {metrics.fileSizeSum > 0 && (
                    <span className="ml-1 text-emerald-700">
                      ({((metrics.totalBytes / metrics.fileSizeSum) * 100).toFixed(0)}% of {(metrics.fileSizeSum / 1e9).toFixed(2)} GB)
                    </span>
                  )}
                </span>
                <span className="text-slate-500">Read rate</span>
                <span className="font-mono">
                  {(metrics.totalBytes / 1e6 / (metrics.totalMs / 1000)).toFixed(0)} MB/s
                </span>
                <span className="text-slate-500">Partial</span>
                <span className="font-mono">
                  {metrics.partialCount}/{metrics.totalImages}
                  {metrics.totalImages > 0 && (
                    <span className="ml-1 text-slate-400">
                      ({((metrics.partialCount / metrics.totalImages) * 100).toFixed(0)}%)
                    </span>
                  )}
                </span>
                {previousFullMs !== null && metrics.partialCount > 0 && (
                  <>
                    <span className="text-slate-500">Prev full</span>
                    <span className="font-mono">
                      {(previousFullMs / 1000).toFixed(2)} s
                      <span className="ml-1 text-emerald-700">
                        ({(((previousFullMs - metrics.totalMs) / previousFullMs) * 100).toFixed(0)}% faster · ×{(previousFullMs / metrics.totalMs).toFixed(2)})
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="rounded border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
              <div className="text-xs font-semibold text-slate-700">
                Folders ({results.length}/{folders.length})
              </div>
              {folders.length > 0 && (
                <div className="flex gap-1 text-[10px]">
                  <button
                    onClick={() => setAllVisible(true)}
                    className="rounded border border-slate-300 px-1.5 py-0.5 hover:bg-slate-100"
                  >
                    All
                  </button>
                  <button
                    onClick={() => setAllVisible(false)}
                    className="rounded border border-slate-300 px-1.5 py-0.5 hover:bg-slate-100"
                  >
                    None
                  </button>
                </div>
              )}
            </div>
            <div className="max-h-[40vh] overflow-auto">
              {folders.length === 0 ? (
                <div className="p-3 text-center text-xs text-slate-400">No folders loaded</div>
              ) : (
                <ul className="text-xs">
                  {folders.map((g, idx) => {
                    const r = results[idx];
                    const isSelected = idx === selectedFolderIdx;
                    const color = colorForFolder(idx, folders.length);
                    const visible = visibleSet.has(idx);
                    return (
                      <li
                        key={g.name}
                        ref={isSelected ? activeRowRef : undefined}
                        className={`flex items-center gap-1.5 border-b border-slate-100 px-2 py-1 last:border-b-0 ${
                          isSelected ? 'bg-cyan-100' : 'hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={visible}
                          onChange={() => toggleVisible(idx)}
                          className="h-3 w-3 cursor-pointer"
                          style={{ accentColor: color }}
                          title="Show this folder in chart"
                        />
                        <span
                          className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: visible ? color : 'transparent', border: `1px solid ${color}` }}
                        />
                        <span
                          onClick={() => r?.best && setSelectedFolderIdx(idx)}
                          className="flex-1 cursor-pointer truncate"
                          title={g.name}
                        >
                          <span className="mr-1 text-slate-400">{String(idx + 1).padStart(2, '0')}</span>
                          {g.name}
                        </span>
                        {r?.best ? (
                          <span className="rounded bg-emerald-200 px-1.5 py-0.5 text-[10px] font-mono text-emerald-800">
                            {r.best.bestFrameIdx.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-400">—</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </aside>

        {/* Middle: ROI editor */}
        <div
          className="flex flex-col overflow-hidden"
          style={{ width: editorWidth }}
        >
          <BestFocusRoiEditor
            bitmap={previewBitmap}
            imageName={previewName}
            roi={roi}
            onRoiChange={setRoi}
          />
        </div>

        {/* Splitter — drag to resize editor width */}
        <div
          className="group w-[5px] cursor-col-resize border-x border-slate-300 bg-slate-200 hover:bg-cyan-400"
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            splitDragRef.current = { startX: e.clientX, startWidth: editorWidth };
          }}
          onPointerMove={(e) => {
            if (!splitDragRef.current) return;
            const delta = e.clientX - splitDragRef.current.startX;
            const next = Math.max(280, Math.min(1200, splitDragRef.current.startWidth + delta));
            setEditorWidth(next);
          }}
          onPointerUp={() => {
            if (splitDragRef.current) {
              try { localStorage.setItem('bf_editor_width', String(editorWidth)); } catch { /* */ }
              splitDragRef.current = null;
            }
          }}
          onPointerCancel={() => { splitDragRef.current = null; }}
          title="Drag to resize"
        />

        {/* Main: edgeness chart + height summary */}
        <main className="flex flex-1 flex-col gap-3 overflow-hidden p-3">
          <div className="flex flex-1 flex-col rounded border border-slate-200 bg-white p-3">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold text-slate-700">
                Edgeness vs frame · <span className="text-slate-500">{visibleSet.size}/{folders.length} folders</span>
                {selected && <span className="ml-2 text-slate-700">· focus: {selected.name}</span>}
              </span>
              {selected?.best && (
                <span className="text-xs text-slate-600 font-mono">
                  best raw {selected.best.bestFrameIdxRaw} · sub {selected.best.bestFrameIdx.toFixed(3)} · max {selected.best.maxEdgeness.toExponential(2)}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1">
              {mergedChartData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">
                  {running ? 'Computing…' : 'Run to populate'}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={mergedChartData} margin={{ top: 8, right: 12, left: 36, bottom: 4 }}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                    <XAxis dataKey="i" type="number" domain={[0, xMax]} stroke="#94a3b8" tick={{ fontSize: 10 }} />
                    <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} tickFormatter={(v) => Number(v).toExponential(1)} />
                    <Tooltip
                      contentStyle={{ fontSize: 11, padding: '4px 8px' }}
                      labelFormatter={(label) => `Frame ${label}`}
                      formatter={(value: unknown, name: unknown) => {
                        const idx = parseInt(String(name).replace(/^f/, ''), 10);
                        const folderName = folders[idx]?.name ?? String(name);
                        const text = typeof value === 'number' ? value.toExponential(2) : String(value);
                        return [text, folderName];
                      }}
                    />
                    {selected?.best && (
                      <ReferenceLine
                        x={selected.best.bestFrameIdx}
                        stroke="#0891b2"
                        strokeDasharray="3 3"
                        label={{ value: selected.best.bestFrameIdx.toFixed(2), position: 'top', fontSize: 10, fill: '#0891b2' }}
                      />
                    )}
                    {folders.map((_, idx) => {
                      if (!visibleSet.has(idx)) return null;
                      const isSel = idx === selectedFolderIdx;
                      return (
                        <Line
                          key={idx}
                          type="monotone"
                          dataKey={`f${idx}`}
                          stroke={colorForFolder(idx, folders.length)}
                          strokeWidth={isSel ? 2.2 : 0.9}
                          strokeOpacity={isSel ? 1 : 0.55}
                          dot={false}
                          isAnimationActive={false}
                          connectNulls
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="flex h-72 flex-col rounded border border-slate-200 bg-white p-3">
            <div className="mb-1 text-xs font-semibold text-slate-700">
              {batchRows && batchRows.length > 0
                ? `ETW batch trend · ${batchRows.length} folders × ${points.length} points`
                : 'Height (µm) vs Best frame index'}
            </div>
            <div className="min-h-0 flex-1">
              {batchRows && batchRows.length > 0 ? (
                <EtwBatchTrendChart rows={batchRows} points={points} />
              ) : heightChartData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">
                  Folder names must contain a height (e.g. "39100um")
                  <br />
                  Save ETW CSV to see the H/V/Average trend chart
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 8, right: 12, left: 30, bottom: 4 }}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                    <XAxis dataKey="height" type="number" name="height" stroke="#94a3b8" tick={{ fontSize: 10 }} unit="µm" />
                    <YAxis dataKey="best" type="number" name="best frame" stroke="#94a3b8" tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ fontSize: 11, padding: '4px 8px' }}
                      formatter={(value: unknown, name: unknown) => [
                        typeof value === 'number' ? value.toFixed(3) : String(value),
                        String(name),
                      ]}
                      labelFormatter={() => ''}
                    />
                    <Scatter data={heightChartData} fill="#059669" line shape="circle" />
                  </ScatterChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </main>
      </div>

      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        // @ts-expect-error webkitdirectory is non-standard
        webkitdirectory=""
        directory=""
        multiple
        onChange={(e) => {
          onPickFolder(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
