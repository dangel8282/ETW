import { useEffect, useMemo, useRef, useState } from 'react';
import { HeightTrendChart } from './HeightTrendChart';
import { TiltTrendChart, type TiltTrendPoint } from './TiltTrendChart';
import { MultiRoiEditor } from './MultiRoiEditor';
import { colorForRoiIdx, defaultMultiRois, parseStepFromFilename, type NamedRoi } from '../lib/multiRoi';
import { findBestFocus, type BestFocusResult } from '../lib/etwBestFocus';
import MrbfWorker from '../lib/multiRoiBfWorker.ts?worker';
import type { MrbfWorkerResult, MrbfWorkerTask } from '../lib/multiRoiBfWorker';
import { buildMultiRoiCsv, type MrbfFolderRow } from '../lib/multiRoiCsv';
import { downloadCsv } from '../lib/etwCsv';
import {
  findCacheByBase,
  findCacheExact,
  makeBaseFingerprint,
  makeFingerprint,
  saveCache,
  type MrbfCacheEntry,
} from '../lib/multiRoiCache';

const IMAGE_EXT_RE = /\.(bmp|png|jpe?g|tiff?|gif|webp)$/i;
const naturalSort = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

interface FolderInput {
  name: string;
  files: File[];
}

function groupByFolder(filelist: FileList): FolderInput[] {
  const groups = new Map<string, File[]>();
  for (const f of Array.from(filelist)) {
    if (!IMAGE_EXT_RE.test(f.name)) continue;
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const parts = path.split('/');
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

const STORAGE_KEY_ROIS = 'mrbf_last_rois';
const STORAGE_KEY_MODE = 'mrbf_last_mode';
const STORAGE_KEY_LAST_NAME = 'mrbf_last_folder_name';
const STORAGE_KEY_LAST_INFO = 'mrbf_last_folder_info';
const N_WORKERS = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

// 모드 전환 시에도 폴더 / 선택 상태 유지하기 위한 module-level cache.
// File 객체는 사용자 다이얼로그 거친 후라 reference 그대로 보관 가능.
const sessionCache: {
  folders: FolderInput[];
  selectedFolderIdx: number;
  previewFrameIdx: number;
} = {
  folders: [],
  selectedFolderIdx: 0,
  previewFrameIdx: 0,
};

function parseHeightUm(name: string): number | null {
  const m = name.match(/(-?\d+(?:\.\d+)?)\s*um/i);
  return m ? parseFloat(m[1]) : null;
}

interface FolderResult {
  name: string;
  heightUm: number | null;
  count: number;
  edgenessByRoi: number[][];           // [roiIdx][frameIdx]
  bestByRoi: (BestFocusResult | null)[];
  decodeMs: number;
  edgenessMs: number;
}

interface RunMetrics {
  totalMs: number;
  decodeMs: number;
  edgenessMs: number;
  totalImages: number;
  totalPixels: number;
  totalBytes: number;
  partialCount: number;          // partial path 로 처리된 이미지 수
  fileSizeSum: number;           // 원본 파일 사이즈 합 (절감 비교용)
}

interface Props {
  onClose: () => void;
}

export function MultiRoiBestFocus({ onClose }: Props) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const workersRef = useRef<Worker[]>([]);
  const cleanupRef = useRef<(() => void) | null>(null);

  const [folders, setFolders] = useState<FolderInput[]>(sessionCache.folders);
  const [previewBitmap, setPreviewBitmap] = useState<ImageBitmap | null>(null);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [rois, setRois] = useState<NamedRoi[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ROIS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed as NamedRoi[];
      }
    } catch { /* */ }
    return [];
  });
  const [selectedRoiId, setSelectedRoiId] = useState<string | null>(rois[0]?.id ?? null);
  const [mode, setMode] = useState<number>(() => {
    const raw = localStorage.getItem(STORAGE_KEY_MODE);
    const v = raw == null ? NaN : parseInt(raw, 10);
    return [0, 1, 2, 3].includes(v) ? v : 0;
  });
  const [status, setStatus] = useState<string>(
    sessionCache.folders.length > 0
      ? `${sessionCache.folders.length} folder(s) restored — pick to refresh`
      : 'Pick a parent folder',
  );

  const [results, setResults] = useState<FolderResult[]>([]);
  const [selectedFolderIdx, setSelectedFolderIdx] = useState<number>(sessionCache.selectedFolderIdx);
  const [previewFrameIdx, setPreviewFrameIdx] = useState<number>(sessionCache.previewFrameIdx);

  // session cache 업데이트 (모든 useState 선언 이후에 위치해야 TDZ 회피)
  useEffect(() => { sessionCache.folders = folders; }, [folders]);
  useEffect(() => { sessionCache.selectedFolderIdx = selectedFolderIdx; }, [selectedFolderIdx]);
  useEffect(() => { sessionCache.previewFrameIdx = previewFrameIdx; }, [previewFrameIdx]);

  // Collapsible 패널 상태 — localStorage 보존
  const [roiPanelOpen, setRoiPanelOpen] = useState<boolean>(() => localStorage.getItem('mrbf_roi_open') !== '0');
  const [speedPanelOpen, setSpeedPanelOpen] = useState<boolean>(() => localStorage.getItem('mrbf_speed_open') !== '0');
  useEffect(() => { try { localStorage.setItem('mrbf_roi_open', roiPanelOpen ? '1' : '0'); } catch { /* */ } }, [roiPanelOpen]);
  useEffect(() => { try { localStorage.setItem('mrbf_speed_open', speedPanelOpen ? '1' : '0'); } catch { /* */ } }, [speedPanelOpen]);
  const [running, setRunning] = useState<boolean>(false);
  const [progress, setProgress] = useState<{ done: number; total: number; folderDone: number; folderTotal: number } | null>(null);
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);

  // 저장: ROI / mode 변경 후 500ms debounce
  useEffect(() => {
    if (rois.length === 0) return;
    const t = window.setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY_ROIS, JSON.stringify(rois)); } catch { /* */ }
    }, 500);
    return () => window.clearTimeout(t);
  }, [rois]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY_MODE, String(mode)); } catch { /* */ }
    }, 500);
    return () => window.clearTimeout(t);
  }, [mode]);

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

    // ROI/mode 까지 정확 일치하는 캐시 우선
    const exactFp = makeFingerprint(topFolder, groups.length, totalImgs, rois, mode);
    let cache = findCacheExact(exactFp);
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
  }

  function applyCache(cache: MrbfCacheEntry, groups: FolderInput[], exactRoiMatch: boolean) {
    const byName = new Map(cache.results.map((r) => [r.name, r]));
    const aligned: FolderResult[] = groups.map((g) => {
      const c = byName.get(g.name);
      if (c) {
        return {
          name: c.name,
          heightUm: c.heightUm,
          count: c.count,
          edgenessByRoi: c.edgenessByRoi.map((arr) => arr.slice()),
          bestByRoi: c.bestByRoi.slice(),
          decodeMs: c.decodeMs,
          edgenessMs: c.edgenessMs,
        };
      }
      return {
        name: g.name,
        heightUm: parseHeightUm(g.name),
        count: g.files.length,
        edgenessByRoi: cache.rois.map(() => new Array<number>(g.files.length).fill(0)),
        bestByRoi: new Array(cache.rois.length).fill(null),
        decodeMs: 0,
        edgenessMs: 0,
      };
    });
    setResults(aligned);
    setMetrics({
      totalMs: cache.totalMs,
      decodeMs: 0,
      edgenessMs: 0,
      totalImages: cache.totalImages,
      totalPixels: cache.totalPixels,
      totalBytes: cache.totalBytes,
      partialCount: cache.partialCount,
      fileSizeSum: cache.fileSizeSum,
    });
    if (!exactRoiMatch) {
      // ROI/mode 도 캐시 값으로 복원
      setRois(cache.rois);
      setSelectedRoiId(cache.rois[0]?.id ?? null);
      setMode(cache.mode);
    }
    const at = new Date(cache.timestamp).toLocaleString();
    setStatus(
      exactRoiMatch
        ? `Loaded cached result from ${at}`
        : `Loaded cached result from ${at} (ROI/mode restored)`,
    );
  }

  // 컴포넌트 mount 시 session cache 에서 폴더 복원되어 있으면 결과 자동 조회/적용
  useEffect(() => {
    if (folders.length === 0 || results.length > 0) return;
    const totalImgs = folders.reduce((a, g) => a + g.files.length, 0);
    const firstPath = (folders[0].files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const topFolder = firstPath.split('/')[0] || '';
    const exactFp = makeFingerprint(topFolder, folders.length, totalImgs, rois, mode);
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

  // 선택된 폴더 / frame 의 이미지 미리보기 — 폴더 또는 frame 변경 시 다시 로드
  useEffect(() => {
    if (folders.length === 0) {
      setPreviewBitmap((prev) => { prev?.close?.(); return null; });
      setPreviewName(null);
      return;
    }
    const folder = folders[Math.max(0, Math.min(folders.length - 1, selectedFolderIdx))];
    if (!folder || folder.files.length === 0) {
      setPreviewBitmap((prev) => { prev?.close?.(); return null; });
      setPreviewName(null);
      return;
    }
    const fi = Math.max(0, Math.min(folder.files.length - 1, previewFrameIdx));
    const file = folder.files[fi];
    let aborted = false;
    createImageBitmap(file)
      .then((bitmap) => {
        if (aborted) {
          bitmap.close?.();
          return;
        }
        setPreviewBitmap((prev) => { prev?.close?.(); return bitmap; });
        setPreviewName(file.name);
      })
      .catch((e) => console.warn('Preview load failed', e));
    return () => { aborted = true; };
  }, [folders, selectedFolderIdx, previewFrameIdx]);

  // 폴더 변경 시 frame idx 범위 보정
  useEffect(() => {
    const folder = folders[selectedFolderIdx];
    if (!folder) return;
    if (previewFrameIdx >= folder.files.length) {
      setPreviewFrameIdx(Math.max(0, folder.files.length - 1));
    }
  }, [folders, selectedFolderIdx, previewFrameIdx]);

  // 첫 이미지 로드 시 ROI 가 비어있으면 기본 3개 자동 배치
  useEffect(() => {
    if (!previewBitmap) return;
    if (rois.length === 0) {
      const def = defaultMultiRois(previewBitmap.width, previewBitmap.height);
      setRois(def);
      setSelectedRoiId(def[0].id);
    }
  }, [previewBitmap, rois.length]);

  const setRoiField = (id: string, key: 'x' | 'y' | 'width' | 'height', v: number) => {
    setRois((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: Math.max(0, Math.round(v)) } : r)));
  };

  const updateRoi = (id: string, next: Pick<NamedRoi, 'x' | 'y' | 'width' | 'height'>) => {
    setRois((prev) => prev.map((r) => (r.id === id ? { ...r, ...next } : r)));
  };

  const resetRois = () => {
    if (!previewBitmap) return;
    const def = defaultMultiRois(previewBitmap.width, previewBitmap.height);
    setRois(def);
    setSelectedRoiId(def[0].id);
  };

  async function onRun() {
    if (folders.length === 0 || rois.length === 0 || running) return;
    setRunning(true);
    setMetrics(null);
    setProgress({ done: 0, total: 0, folderDone: 0, folderTotal: folders.length });

    const totalTasks = folders.reduce((s, f) => s + f.files.length, 0);
    const folderTotal = folders.length;
    const roiCount = rois.length;

    // 결과 컨테이너 초기화
    const folderResults: FolderResult[] = folders.map((f) => ({
      name: f.name,
      heightUm: parseHeightUm(f.name),
      count: f.files.length,
      edgenessByRoi: Array.from({ length: roiCount }, () => new Array<number>(f.files.length).fill(0)),
      bestByRoi: new Array(roiCount).fill(null),
      decodeMs: 0,
      edgenessMs: 0,
    }));
    setResults([...folderResults]);

    const folderCompleted = new Array(folderTotal).fill(0);

    const tasks: { folderIdx: number; frameIdx: number; file: File }[] = [];
    folders.forEach((folder, folderIdx) => {
      folder.files.forEach((file, frameIdx) => {
        tasks.push({ folderIdx, frameIdx, file });
      });
    });

    const workers: Worker[] = Array.from({ length: N_WORKERS }, () => new MrbfWorker());
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
        setResults(folderResults.map((r) => ({
          ...r,
          edgenessByRoi: r.edgenessByRoi.map((arr) => arr.slice()),
        })));
        if (cancelled) {
          setStatus(`Cancelled — ${foldersDone}/${folderTotal} folders done in ${(totalMs / 1000).toFixed(2)}s`);
        } else {
          setStatus(
            `Done: ${folderTotal} folders × ${roiCount} ROI in ${(totalMs / 1000).toFixed(2)}s ` +
              `(${N_WORKERS} workers, ~${(totalMs / Math.max(1, folderTotal)).toFixed(0)} ms/folder)`,
          );
          // 캐시 저장
          try {
            const firstPath = (folders[0]?.files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
            const topFolder = firstPath.split('/')[0] || '';
            const totalImgs = folders.reduce((s, f) => s + f.files.length, 0);
            const baseFp = makeBaseFingerprint(topFolder, folderTotal, totalImgs);
            const fp = makeFingerprint(topFolder, folderTotal, totalImgs, rois, mode);
            const entry: MrbfCacheEntry = {
              fingerprint: fp,
              baseFingerprint: baseFp,
              topFolder,
              folderCount: folderTotal,
              totalImages: totalImgs,
              rois,
              mode,
              totalMs,
              totalPixels: aggPixels,
              totalBytes: aggBytes,
              partialCount: aggPartial,
              fileSizeSum: aggFileSize,
              timestamp: Date.now(),
              results: folderResults.map((r) => ({
                name: r.name,
                heightUm: r.heightUm,
                count: r.count,
                edgenessByRoi: r.edgenessByRoi.map((arr) => arr.slice()),
                bestByRoi: r.bestByRoi,
                decodeMs: r.decodeMs,
                edgenessMs: r.edgenessMs,
              })),
            };
            saveCache(entry);
          } catch (err) {
            console.warn('Failed to cache result', err);
          }
        }
        resolve();
      };
      cleanupRef.current = () => cleanup(true);

      const roisPayload = rois.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));

      function assignNext(worker: Worker) {
        if (nextTaskIdx >= tasks.length) return;
        const task = tasks[nextTaskIdx++];
        const msg: MrbfWorkerTask = {
          folderIdx: task.folderIdx,
          frameIdx: task.frameIdx,
          file: task.file,
          rois: roisPayload,
          mode,
        };
        worker.postMessage(msg);
      }

      for (const worker of workers) {
        worker.onmessage = (e: MessageEvent<MrbfWorkerResult>) => {
          if (resolved) return;
          const { folderIdx, frameIdx, edgenesses, decodeMs, edgenessMs, pixels, bytes, partial } = e.data;
          const fr = folderResults[folderIdx];
          for (let i = 0; i < edgenesses.length; i++) {
            fr.edgenessByRoi[i][frameIdx] = edgenesses[i];
          }
          fr.decodeMs += decodeMs;
          fr.edgenessMs += edgenessMs;
          aggDecodeMs += decodeMs;
          aggEdgeMs += edgenessMs;
          aggPixels += pixels;
          aggBytes += bytes;
          if (partial) aggPartial++;
          // 원본 파일 사이즈는 task 객체에서 직접
          aggFileSize += folders[folderIdx].files[frameIdx].size;
          folderCompleted[folderIdx]++;
          completedTasks++;

          if (folderCompleted[folderIdx] === folders[folderIdx].files.length) {
            // 파일명에서 step 값 추출 — 모두 추출되면 stepList 전달 (best step value 계산)
            const folderFiles = folders[folderIdx].files;
            const stepList = folderFiles.map((f) => parseStepFromFilename(f.name));
            const hasAllSteps = stepList.every((s): s is number => s !== null);
            const stepArg = hasAllSteps ? (stepList as number[]) : undefined;
            for (let i = 0; i < roiCount; i++) {
              fr.bestByRoi[i] = findBestFocus(fr.edgenessByRoi[i], stepArg);
            }
            foldersDone++;
          }

          if ((completedTasks & 31) === 0 || completedTasks === totalTasks) {
            setProgress({ done: completedTasks, total: totalTasks, folderDone: foldersDone, folderTotal });
            setResults(folderResults.map((r) => ({
              ...r,
              edgenessByRoi: r.edgenessByRoi.map((arr) => arr.slice()),
            })));
          }

          if (nextTaskIdx < tasks.length) {
            assignNext(worker);
          } else if (completedTasks === totalTasks) {
            cleanup(false);
          }
        };
        worker.onerror = (err) => console.error('Worker error', err);
      }

      for (const w of workers) assignNext(w);
    });
  }

  function onCancel() {
    cleanupRef.current?.();
  }

  function onSaveCsv() {
    if (results.length === 0 || rois.length === 0) return;
    const completed = results.filter((r) => r.bestByRoi.some((b) => b !== null));
    if (completed.length === 0) {
      setStatus('No results to export');
      return;
    }
    const rows: MrbfFolderRow[] = completed.map((r, idx) => {
      const folder = folders[idx];
      return {
        folderName: r.name,
        heightUm: r.heightUm,
        imageCount: r.count,
        bestByRoi: r.bestByRoi.map((best) => {
          let bestImageName = '';
          if (best && folder) {
            const fi = Math.max(0, Math.min(folder.files.length - 1, best.bestFrameIdxRaw));
            bestImageName = folder.files[fi]?.name ?? '';
          }
          return { bestImageName, result: best };
        }),
      };
    });
    const csv = buildMultiRoiCsv(rois, rows);
    downloadCsv(`mrbf_${completed.length}_folders.csv`, csv);
    setStatus(`CSV saved: ${completed.length} folders × ${rois.length} ROI`);
  }

  // 키보드 ↑/↓ 폴더 이동
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
        if (next !== selectedFolderIdx) {
          e.preventDefault();
          setSelectedFolderIdx(next);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedFolderIdx, results.length]);

  const selectedFolderResult = results[selectedFolderIdx];

  // CSV / Run 활성화 여부
  const canRun = folders.length > 0 && rois.length > 0 && !running;
  const canCsv = !running && results.some((r) => r.bestByRoi.some((b) => b !== null));


  // 모든 폴더의 height vs best step (ROI별) — trend 비교용
  const heightTrendData = useMemo(() => {
    return results
      .map((r, idx) => {
        if (!r.bestByRoi.some((b) => b !== null) || r.heightUm === null) return null;
        return {
          height: r.heightUm,
          folderIdx: idx,
          name: r.name,
          bestByRoi: r.bestByRoi.map((b) => (b ? b.bestStepValue : null)),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [results]);

  const selectedHeight = selectedFolderResult?.heightUm ?? null;

  // Tilt trend — BF_i − BF_center 와 평균
  const centerIdx = rois.length >= 2 ? 1 : -1;
  const tiltTrendData = useMemo<TiltTrendPoint[]>(() => {
    if (centerIdx < 0) return [];
    return results
      .map((r, idx) => {
        if (r.heightUm === null) return null;
        const center = r.bestByRoi[centerIdx]?.bestStepValue ?? null;
        if (center === null || !Number.isFinite(center)) return null;
        const diffByRoi: (number | null)[] = r.bestByRoi.map((b, i) => {
          if (i === centerIdx) return null;
          const v = b?.bestStepValue;
          if (v == null || !Number.isFinite(v)) return null;
          return v - center;
        });
        const validDiffs = diffByRoi.filter((d): d is number => d !== null);
        const avg = validDiffs.length >= 2
          ? validDiffs.reduce((a, b) => a + b, 0) / validDiffs.length
          : null;
        return {
          height: r.heightUm,
          folderIdx: idx,
          name: r.name,
          diffByRoi,
          avg,
        };
      })
      .filter((x): x is TiltTrendPoint => x !== null);
  }, [results, centerIdx]);


  return (
    <div className="flex h-screen flex-col bg-slate-100">
      <header className="flex items-center justify-between border-b border-slate-300 bg-white px-4 py-2 shadow-sm">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100">
            ← Back to ETW
          </button>
          <div className="text-base font-bold text-slate-800">Multi-ROI Best Focus</div>
        </div>
        <div className="truncate text-xs text-slate-600">{status}</div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="flex w-[320px] flex-col gap-3 overflow-y-auto border-r border-slate-300 bg-slate-50 p-3">
          <div className="rounded border border-slate-200 bg-white p-3">
            <button
              onClick={() => folderInputRef.current?.click()}
              className="w-full rounded bg-slate-700 px-2 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
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
            <div className="mb-2 flex items-center justify-between">
              <button
                onClick={() => setRoiPanelOpen((v) => !v)}
                className="flex flex-1 items-center gap-1.5 text-left text-xs font-semibold text-slate-700"
              >
                <span className="text-slate-400">{roiPanelOpen ? '▼' : '▶'}</span>
                ROIs (Left / Center / Right)
              </button>
              {roiPanelOpen && (
                <button
                  className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] hover:bg-slate-100"
                  onClick={resetRois}
                  disabled={!previewBitmap}
                  title="Reset to default positions"
                >Reset</button>
              )}
            </div>
            {roiPanelOpen && (rois.length === 0 ? (
              <div className="text-xs text-slate-400">Load a folder to auto-place Left/Center/Right</div>
            ) : (
              <ul className="flex flex-col gap-2 text-xs">
                {rois.map((roi, idx) => {
                  const color = colorForRoiIdx(idx);
                  const isSel = roi.id === selectedRoiId;
                  return (
                    <li
                      key={roi.id}
                      onClick={() => setSelectedRoiId(roi.id)}
                      className={`cursor-pointer rounded border p-2 ${
                        isSel ? 'border-cyan-500 bg-cyan-50' : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <span
                          className="inline-block h-3 w-3 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                        <input
                          type="text"
                          value={roi.name}
                          onChange={(e) => setRois((prev) => prev.map((r) => (r.id === roi.id ? { ...r, name: e.target.value } : r)))}
                          onClick={(e) => e.stopPropagation()}
                          className="bg-transparent text-xs font-medium text-slate-700 outline-none"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                        {(['x', 'y', 'width', 'height'] as const).map((k) => (
                          <label key={k} className="flex items-center justify-between gap-1 text-[10px]">
                            <span className="text-slate-500">{k === 'width' ? 'w' : k === 'height' ? 'h' : k}</span>
                            <input
                              type="number"
                              value={(roi as NamedRoi)[k]}
                              onChange={(e) => setRoiField(roi.id, k, Number(e.target.value))}
                              onClick={(e) => e.stopPropagation()}
                              className="w-16 rounded border border-slate-300 bg-white px-1 py-0.5 text-right"
                            />
                          </label>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ))}
          </div>

          <div className="rounded border border-slate-200 bg-white p-3">
            <div className="mb-2 text-xs font-semibold text-slate-700">Edgeness mode</div>
            <select
              value={mode}
              onChange={(e) => setMode(Number(e.target.value))}
              disabled={running}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              <option value={0}>0 — Sobel²</option>
              <option value={2}>2 — Sobel</option>
              <option value={1}>1 — Laplacian²</option>
              <option value={3}>3 — Laplacian</option>
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
                  style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                />
              </div>
              <div className="mt-1 text-[10px] text-slate-500">
                {N_WORKERS} workers · {((progress.done / Math.max(1, progress.total)) * 100).toFixed(1)}%
              </div>
              <button
                className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                onClick={onCancel}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                className="w-full rounded bg-emerald-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                disabled={!canRun}
                onClick={onRun}
              >
                Run Best Focus
              </button>
              <button
                className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-40"
                disabled={!canCsv}
                onClick={onSaveCsv}
              >
                Save CSV
              </button>
            </div>
          )}

          {metrics && (
            <div className="rounded border border-slate-200 bg-white p-3 text-xs">
              <button
                onClick={() => setSpeedPanelOpen((v) => !v)}
                className="mb-1 flex w-full items-center gap-1.5 text-left font-semibold text-slate-700"
              >
                <span className="text-slate-400">{speedPanelOpen ? '▼' : '▶'}</span>
                Speed
              </button>
              {speedPanelOpen && <div className="grid grid-cols-[110px_1fr] gap-y-0.5">
                <span className="text-slate-500">Total</span>
                <span className="font-mono">{(metrics.totalMs / 1000).toFixed(2)} s</span>
                <span className="text-slate-500">Per folder</span>
                <span className="font-mono">{(metrics.totalMs / Math.max(1, folders.length)).toFixed(0)} ms</span>
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
                  {(metrics.totalPixels / 1e9).toFixed(2)} Gpx
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
              </div>}
            </div>
          )}

        </aside>

        {/* Folders panel — 별도 column */}
        <aside className="flex w-[280px] flex-col overflow-hidden border-r border-slate-300 bg-slate-50">
          <div className="border-b border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700">
            Folders ({folders.length})
          </div>
          <div className="flex-1 overflow-auto">
            {folders.length === 0 ? (
              <div className="p-3 text-center text-xs text-slate-400">No folders loaded</div>
            ) : (
              <ul className="text-xs">
                {folders.map((g, idx) => {
                  const r = results[idx];
                  const isSel = idx === selectedFolderIdx;
                  return (
                    <li
                      key={g.name}
                      ref={isSel ? (el) => { el?.scrollIntoView({ block: 'nearest' }); } : undefined}
                      onClick={() => setSelectedFolderIdx(idx)}
                      className={`flex cursor-pointer items-center justify-between border-b border-slate-100 px-2 py-1 last:border-b-0 ${
                        isSel ? 'bg-cyan-100' : 'hover:bg-slate-100'
                      }`}
                      title={g.name}
                    >
                      <span className="truncate">
                        <span className="mr-1 text-slate-400">{String(idx + 1).padStart(3, '0')}</span>
                        {g.name}
                      </span>
                      {r?.bestByRoi.some((b) => b !== null) ? (
                        <span className="ml-2 whitespace-nowrap text-[10px] text-emerald-700 font-mono">
                          {r.bestByRoi.map((b) => b ? b.bestStepValue.toFixed(1) : '–').join(' / ')}
                        </span>
                      ) : (
                        <span className="ml-2 text-[10px] text-slate-400">{g.files.length}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* Main — ROI editor (top) + Edgeness chart (bottom) */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-col overflow-hidden" style={{ flexBasis: '50%', minHeight: 0 }}>
            {/* Preview selector toolbar */}
            <div className="flex items-center gap-3 border-b border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200">
              <label className="flex items-center gap-1.5">
                <span className="text-slate-400">Folder:</span>
                <select
                  value={selectedFolderIdx}
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    setSelectedFolderIdx(idx);
                  }}
                  disabled={folders.length === 0}
                  className="max-w-[200px] rounded border border-slate-600 bg-slate-900 px-2 py-0.5 text-xs text-slate-100 focus:outline-none"
                >
                  {folders.length === 0 ? (
                    <option>(none)</option>
                  ) : (
                    folders.map((f, i) => (
                      <option key={f.name} value={i}>
                        {String(i + 1).padStart(3, '0')} · {f.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-slate-400">Image:</span>
                <select
                  value={previewFrameIdx}
                  onChange={(e) => setPreviewFrameIdx(Number(e.target.value))}
                  disabled={!folders[selectedFolderIdx] || folders[selectedFolderIdx].files.length === 0}
                  className="max-w-[260px] rounded border border-slate-600 bg-slate-900 px-2 py-0.5 text-xs text-slate-100 focus:outline-none"
                >
                  {folders[selectedFolderIdx]?.files.map((f, i) => (
                    <option key={i} value={i}>
                      {String(i + 1).padStart(3, '0')} · {f.name}
                    </option>
                  )) ?? <option>(none)</option>}
                </select>
              </label>
              {/* best 로 빠르게 점프 — 라벨은 step 값(파일명 step), 점프는 frame idx */}
              {results[selectedFolderIdx]?.bestByRoi.some((b) => b !== null) && (
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400">Jump to best:</span>
                  {results[selectedFolderIdx].bestByRoi.map((b, i) => {
                    if (!b) return null;
                    // bestStepValue 가 파일명 step 으로 보간된 값
                    const stepLabel = Number.isFinite(b.bestStepValue) ? b.bestStepValue.toFixed(1) : `f${b.bestFrameIdxRaw}`;
                    return (
                      <button
                        key={i}
                        onClick={() => setPreviewFrameIdx(b.bestFrameIdxRaw)}
                        className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] hover:bg-slate-700"
                        style={{ color: colorForRoiIdx(i) }}
                        title={`${rois[i]?.name ?? ''} best step ${stepLabel} (frame ${b.bestFrameIdxRaw})`}
                      >
                        {rois[i]?.name?.[0] ?? '?'} {stepLabel}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex-1 overflow-hidden">
              <MultiRoiEditor
                bitmap={previewBitmap}
                imageName={previewName}
                rois={rois}
                selectedRoiId={selectedRoiId}
                onSelectRoi={setSelectedRoiId}
                onRoiChange={updateRoi}
              />
            </div>
          </div>
          <div className="flex border-t border-slate-300 bg-white" style={{ flexBasis: '50%', minHeight: 0 }}>
            {/* 좌: 모든 폴더 height vs best frame — 전체 trend */}
            <div className="flex flex-1 flex-col border-r border-slate-200 p-3">
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="font-semibold text-slate-700">Height (µm) vs Best step · all folders</span>
                <div className="flex gap-2 text-[10px]">
                  {rois.map((r, i) => (
                    <span key={r.id} className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: colorForRoiIdx(i) }} />
                      <span className="text-slate-700">{r.name}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1">
                {heightTrendData.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-slate-400">
                    {running ? 'Computing…' : 'Run to populate (folders must contain height in name)'}
                  </div>
                ) : (
                  <HeightTrendChart
                    data={heightTrendData}
                    rois={rois}
                    selectedHeight={selectedHeight}
                    onPointClick={setSelectedFolderIdx}
                  />
                )}
              </div>
            </div>

            {/* 우: 전체 폴더의 BF 차이 / 평균 추이 (tilt trend) */}
            <div className="flex flex-1 flex-col p-3">
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="font-semibold text-slate-700">
                  Tilt trend · (ROI − Center) per folder
                </span>
                {selectedFolderResult && centerIdx >= 0 && (() => {
                  const center = selectedFolderResult.bestByRoi[centerIdx]?.bestStepValue;
                  if (center == null || !Number.isFinite(center)) return null;
                  const parts = selectedFolderResult.bestByRoi
                    .map((b, i) => {
                      if (i === centerIdx || !b) return null;
                      const d = b.bestStepValue - center;
                      return `${rois[i]?.name ?? ''}−C: ${d.toFixed(1)}`;
                    })
                    .filter(Boolean);
                  return (
                    <span className="text-[10px] text-slate-600 font-mono">{parts.join(' · ')}</span>
                  );
                })()}
              </div>
              <div className="min-h-0 flex-1">
                {centerIdx < 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-slate-400">
                    Need ≥ 2 ROIs to compute tilt
                  </div>
                ) : tiltTrendData.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-slate-400">
                    {running ? 'Computing…' : 'Run to populate (folders must contain height in name)'}
                  </div>
                ) : (
                  <TiltTrendChart
                    data={tiltTrendData}
                    rois={rois}
                    centerIdx={centerIdx}
                    selectedHeight={selectedHeight}
                    onPointClick={setSelectedFolderIdx}
                  />
                )}
              </div>
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
