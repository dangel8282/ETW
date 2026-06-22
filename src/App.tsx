import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { EtwConfig, EtwMeasurementPoint, EtwMeasurementResult } from './lib/etwTypes';
import { analyze } from './lib/etwAnalyzer';
import { loadImageFile, type LoadedImage } from './lib/etwImage';
import { buildCsv, buildCsvMulti, downloadCsv } from './lib/etwCsv';
import {
  downloadConfig,
  importConfigFile,
  loadConfigFromStorage,
  saveConfigToStorage,
} from './lib/etwConfig';
import { ImageCanvas, type PendingRect } from './components/ImageCanvas';
import { SettingsPanel } from './components/SettingsPanel';
import { PointsPanel } from './components/PointsPanel';
import { SelectedResultPanel } from './components/SelectedResultPanel';
import { ProfileGraph } from './components/ProfileGraph';
import { ResultsTable } from './components/ResultsTable';
import { ImageStrip } from './components/ImageStrip';
import { StepNavigator } from './components/StepNavigator';
import { StepTrendGraph } from './components/StepTrendGraph';
import { SaveCsvMenu } from './components/SaveCsvMenu';

interface ImageEntry {
  name: string;
  file: File;
}

const IMAGE_EXT_RE = /\.(bmp|png|jpe?g|tiff?|gif|webp)$/i;
const IMAGE_CACHE_MAX = 8;

function App() {
  // localStorage에서 한 번만 읽어 config + points 둘 다 초기화.
  // (points는 별도 state이지만 첫 mount 시 config.points 로 복원 — 안 그러면
  //  아래 sync effect가 빈 배열로 덮어써서 저장된 점이 사라짐.)
  const initialConfig = useMemo(() => loadConfigFromStorage(), []);
  const [config, setConfig] = useState<EtwConfig>(initialConfig);
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [currentIdx, setCurrentIdx] = useState<number>(0);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [points, setPoints] = useState<EtwMeasurementPoint[]>(() =>
    initialConfig.points.map((p, i) => ({ id: i + 1, x: p.x, y: p.y })),
  );
  const [pending, setPending] = useState<PendingRect | null>(null);
  const [results, setResults] = useState<EtwMeasurementResult[]>([]);
  const [selectedPointId, setSelectedPointId] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('Ready');
  const [batchResults, setBatchResults] = useState<Record<string, EtwMeasurementResult[]>>({});
  const [batchStale, setBatchStale] = useState<boolean>(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const batchCancelRef = useRef<boolean>(false);
  const [clipboard, setClipboard] = useState<{ cx: number; cy: number; w: number; h: number } | null>(null);
  const lastMouseImgRef = useRef<{ x: number; y: number } | null>(null);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const configInputRef = useRef<HTMLInputElement>(null);
  const imageCacheRef = useRef<Map<File, LoadedImage>>(new Map());
  const inflightRef = useRef<Map<File, Promise<LoadedImage>>>(new Map());

  const cacheGet = (file: File): LoadedImage | undefined => {
    const c = imageCacheRef.current;
    const v = c.get(file);
    if (v) {
      c.delete(file);
      c.set(file, v);
    }
    return v;
  };
  const cachePut = (file: File, loaded: LoadedImage) => {
    const c = imageCacheRef.current;
    if (c.has(file)) c.delete(file);
    c.set(file, loaded);
    while (c.size > IMAGE_CACHE_MAX) {
      const k = c.keys().next().value;
      if (k === undefined) break;
      const old = c.get(k)!;
      c.delete(k);
      old.bitmap.close?.();
    }
  };
  const cacheClear = () => {
    for (const v of imageCacheRef.current.values()) v.bitmap.close?.();
    imageCacheRef.current.clear();
    inflightRef.current.clear();
  };
  const loadIntoCache = (file: File): Promise<LoadedImage> => {
    const cached = cacheGet(file);
    if (cached) return Promise.resolve(cached);
    const inflight = inflightRef.current.get(file);
    if (inflight) return inflight;
    const p = loadImageFile(file).then((loaded) => {
      cachePut(file, loaded);
      inflightRef.current.delete(file);
      return loaded;
    }).catch((e) => {
      inflightRef.current.delete(file);
      throw e;
    });
    inflightRef.current.set(file, p);
    return p;
  };

  // Persist config changes
  useEffect(() => {
    saveConfigToStorage(config);
  }, [config]);

  // Sync config.points with the live points list — keeps Save Config and points in sync
  useEffect(() => {
    setConfig((c) => ({ ...c, points: points.map((p) => ({ x: p.x, y: p.y })) }));
  }, [points]);

  // Switch displayed image. LRU cache makes ←/→ navigation instant for recently
  // viewed images; neighbors are prefetched in the background. Bitmap lifetime is
  // owned by the cache (closed only on evict / new folder load).
  useEffect(() => {
    if (images.length === 0) {
      setImage(null);
      return;
    }
    const idx = Math.min(Math.max(0, currentIdx), images.length - 1);
    if (idx !== currentIdx) {
      setCurrentIdx(idx);
      return;
    }
    const entry = images[idx];
    const t0 = performance.now();
    const cached = cacheGet(entry.file);
    // Idle-time prefetch so the user's next ←/→ click isn't held up by neighbor decode.
    const prefetchNeighbors = () => {
      const schedule =
        typeof requestIdleCallback === 'function'
          ? (cb: () => void) => requestIdleCallback(cb, { timeout: 500 })
          : (cb: () => void) => setTimeout(cb, 50);
      const p = (i: number) => {
        if (i < 0 || i >= images.length) return;
        loadIntoCache(images[i].file).catch(() => {});
      };
      schedule(() => p(idx + 1));
      schedule(() => p(idx - 1));
    };
    if (cached) {
      console.log(`[img] hit ${entry.name} ${(performance.now() - t0).toFixed(1)}ms`);
      setImage(cached);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          console.log(`[paint] ${(performance.now() - t0).toFixed(1)}ms`);
        });
      });
      prefetchNeighbors();
      return;
    }
    let aborted = false;
    console.log(`[img] miss ${entry.name} — decoding…`);
    loadIntoCache(entry.file)
      .then((loaded) => {
        console.log(`[img] decoded ${entry.name} ${(performance.now() - t0).toFixed(0)}ms`);
        if (!aborted) {
          setImage(loaded);
          prefetchNeighbors();
        }
      })
      .catch((e) => {
        if (!aborted) setStatus(`Load failed: ${(e as Error).message}`);
      });
    return () => {
      aborted = true;
    };
  }, [images, currentIdx]);

  // Auto re-analyze whenever the image, points, or relevant config knobs change.
  // Lets threshold / ROI / pixel-size tweaks update the canvas markers live.
  useEffect(() => {
    if (!image || points.length === 0) {
      setResults((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const t = performance.now();
    const lowerTh = config.lowerThresholdPercent / 100;
    const upperTh = config.upperThresholdPercent / 100;
    const out: EtwMeasurementResult[] = points.map((p) =>
      analyze(image.gray, {
        cx: p.x,
        cy: p.y,
        width: config.roiWidth,
        height: config.roiHeight,
        lowerTh,
        upperTh,
        pointId: p.id,
        pixelWidthUm: config.pixelWidthUm,
        pixelHeightUm: config.pixelHeightUm,
      }),
    );
    setResults(out);
    const dt = performance.now() - t;
    if (dt > 1) console.log(`[analyze] ${points.length} pts ${dt.toFixed(1)}ms`);
  }, [
    image,
    points,
    config.roiWidth,
    config.roiHeight,
    config.lowerThresholdPercent,
    config.upperThresholdPercent,
    config.pixelWidthUm,
    config.pixelHeightUm,
  ]);

  // Anything that would change measurement output invalidates batchResults.
  // UI ignores stale flag when batchResults is empty.
  useEffect(() => {
    setBatchStale(true);
  }, [
    points,
    config.roiWidth,
    config.roiHeight,
    config.lowerThresholdPercent,
    config.upperThresholdPercent,
    config.pixelWidthUm,
    config.pixelHeightUm,
  ]);

  // Defer heavy right-sidebar updates (Recharts × 3 + table) so the canvas can
  // swap images without waiting for the chart layout to re-run.
  const deferredResults = useDeferredValue(results);
  const deferredSelectedResult = useMemo(
    () => deferredResults.find((r) => r.pointId === selectedPointId) ?? null,
    [deferredResults, selectedPointId],
  );
  const deferredCurrentIdx = useDeferredValue(currentIdx);

  // Stable derivations — avoid new array/closure each render so memo'd children skip re-render.
  const imageNames = useMemo(() => images.map((e) => e.name), [images]);
  const analyzedCount = useCallback(
    (name: string) => batchResults[name]?.length ?? null,
    [batchResults],
  );

  // Auto-select first result so newly registered points and live threshold tweaks
  // always have a highlighted/active point on the canvas + profile graphs.
  useEffect(() => {
    if (selectedPointId === null && results.length > 0) {
      setSelectedPointId(results[0].pointId);
    }
  }, [results, selectedPointId]);

  const loadImagesFromInput = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const entries: ImageEntry[] = Array.from(files)
      .filter((f) => IMAGE_EXT_RE.test(f.name))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      )
      .map((f) => ({ name: f.name, file: f }));
    if (entries.length === 0) {
      setStatus('No supported image files selected');
      return;
    }
    cacheClear();
    setBatchResults({});
    setImages(entries);
    setCurrentIdx(0);
    setResults([]);
    setStatus(`Loaded ${entries.length} image${entries.length > 1 ? 's' : ''}: ${entries[0].name}`);
  };

  const onPending = useCallback((rect: PendingRect | null) => setPending(rect), []);

  const onMovePoint = useCallback((id: number, x: number, y: number) => {
    setPoints((prev) => prev.map((p) => (p.id === id ? { ...p, x, y } : p)));
  }, []);

  const onResizeRoi = useCallback((w: number, h: number) => {
    setConfig((c) => ({ ...c, roiWidth: w, roiHeight: h }));
  }, []);

  const onMouseMoveImage = useCallback((p: { x: number; y: number } | null) => {
    lastMouseImgRef.current = p;
  }, []);

  const onCopyPoint = useCallback(() => {
    if (selectedPointId === null) return;
    const sp = points.find((p) => p.id === selectedPointId);
    if (!sp) return;
    setClipboard({ cx: sp.x, cy: sp.y, w: config.roiWidth, h: config.roiHeight });
    setStatus(`Copied point #${selectedPointId}`);
  }, [selectedPointId, points, config.roiWidth, config.roiHeight]);

  const onPastePoint = useCallback(() => {
    if (!clipboard || !image) return;
    const target = lastMouseImgRef.current ?? { x: clipboard.cx + clipboard.w, y: clipboard.cy };
    const x = Math.max(0, Math.min(image.gray.width - 1, Math.round(target.x)));
    const y = Math.max(0, Math.min(image.gray.height - 1, Math.round(target.y)));
    const newId = points.length + 1;
    setPoints((prev) => [...prev, { id: newId, x, y }]);
    if (clipboard.w !== config.roiWidth || clipboard.h !== config.roiHeight) {
      setConfig((c) => ({ ...c, roiWidth: clipboard.w, roiHeight: clipboard.h }));
    }
    setSelectedPointId(newId);
    setStatus(`Pasted point #${newId} at (${x}, ${y})`);
  }, [clipboard, image, points.length, config.roiWidth, config.roiHeight]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        onCopyPoint();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        onPastePoint();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCopyPoint, onPastePoint]);

  const onRegister = () => {
    if (!pending) return;
    if (pending.w < 4 || pending.h < 4) {
      setStatus('Rectangle too small (w<4 or h<4)');
      return;
    }
    const id = points.length + 1;
    const newPoint: EtwMeasurementPoint = { id, x: pending.cx, y: pending.cy };
    setPoints([...points, newPoint]);
    setConfig({ ...config, roiWidth: pending.w, roiHeight: pending.h });
    setPending(null);
    setSelectedPointId(id);
    setStatus(`Registered #${id} center=(${pending.cx}, ${pending.cy}) size ${pending.w}×${pending.h}`);
  };

  const onDeletePoint = () => {
    if (selectedPointId === null) return;
    const remaining = points
      .filter((p) => p.id !== selectedPointId)
      .map((p, i) => ({ ...p, id: i + 1 }));
    setPoints(remaining);
    setResults([]);
    setSelectedPointId(null);
    setStatus(`Removed point. Total: ${remaining.length}`);
  };

  const onClearPoints = () => {
    setPoints([]);
    setResults([]);
    setSelectedPointId(null);
    setStatus('Points cleared');
  };

  const onSaveCsvCurrent = () => {
    if (results.length === 0 || !image) return;
    const csv = buildCsv(image.name, results);
    const base = image.name.replace(/\.[^.]+$/, '') || 'etw';
    downloadCsv(`${base}_etw.csv`, csv);
  };

  const onSaveCsvAll = () => {
    const entries = images
      .map((e) => ({ imageName: e.name, results: batchResults[e.name] }))
      .filter((r): r is { imageName: string; results: EtwMeasurementResult[] } => Array.isArray(r.results));
    if (entries.length === 0) return;
    const csv = buildCsvMulti(entries);
    downloadCsv(`etw_batch_${entries.length}_images.csv`, csv);
  };

  const onRunAll = async () => {
    if (images.length === 0 || points.length === 0 || batchProgress) return;
    batchCancelRef.current = false;
    setBatchProgress({ done: 0, total: images.length });
    const lowerTh = config.lowerThresholdPercent / 100;
    const upperTh = config.upperThresholdPercent / 100;
    const newResults: Record<string, EtwMeasurementResult[]> = {};
    let failed = 0;
    for (let i = 0; i < images.length; i++) {
      if (batchCancelRef.current) break;
      const entry = images[i];
      try {
        const loaded = await loadImageFile(entry.file);
        newResults[entry.name] = points.map((p) =>
          analyze(loaded.gray, {
            cx: p.x,
            cy: p.y,
            width: config.roiWidth,
            height: config.roiHeight,
            lowerTh,
            upperTh,
            pointId: p.id,
            pixelWidthUm: config.pixelWidthUm,
            pixelHeightUm: config.pixelHeightUm,
          }),
        );
        loaded.bitmap.close?.();
      } catch {
        failed++;
      }
      setBatchProgress({ done: i + 1, total: images.length });
      if ((i & 3) === 3) await new Promise<void>((r) => setTimeout(r, 0));
    }
    setBatchResults(newResults);
    setBatchStale(false);
    setBatchProgress(null);
    const ok = Object.keys(newResults).length;
    if (batchCancelRef.current) {
      setStatus(`Run All cancelled at ${ok}/${images.length}`);
    } else {
      setStatus(`Run All: ${ok}/${images.length}${failed > 0 ? ` (${failed} failed)` : ''}`);
    }
  };

  const onCancelRunAll = () => {
    batchCancelRef.current = true;
  };

  const onSaveConfig = () => downloadConfig(config);

  const onLoadConfig = async (file: File | null) => {
    if (!file) return;
    try {
      const cfg = await importConfigFile(file);
      setConfig(cfg);
      setPoints(cfg.points.map((p, i) => ({ id: i + 1, x: p.x, y: p.y })));
      setResults([]);
      setStatus(`Config loaded: ${cfg.points.length} points, ROI ${cfg.roiWidth}×${cfg.roiHeight}`);
    } catch (e) {
      setStatus(`Config load failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-slate-100">
      <header className="flex items-center justify-between border-b border-slate-300 bg-white px-4 py-2 shadow-sm">
        <div className="text-base font-bold text-slate-800">ETW Evaluation</div>
        <div className="truncate text-xs text-slate-600">{status}</div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex w-[210px] flex-col border-r border-slate-300 bg-slate-50">
          <ImageStrip
            names={imageNames}
            currentIdx={currentIdx}
            totalPoints={points.length}
            analyzedCount={analyzedCount}
            onSelect={setCurrentIdx}
          />
          <div className="border-t border-slate-300 bg-white p-2 text-xs">
            {batchProgress ? (
              <>
                <div className="mb-1 flex justify-between text-slate-700">
                  <span>Running…</span>
                  <span className="font-mono">{batchProgress.done}/{batchProgress.total}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-slate-200">
                  <div
                    className="h-full bg-cyan-500 transition-all"
                    style={{ width: `${(batchProgress.done / batchProgress.total) * 100}%` }}
                  />
                </div>
                <button
                  className="mt-2 w-full rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
                  onClick={onCancelRunAll}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="w-full rounded bg-emerald-600 px-2 py-1.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                disabled={images.length === 0 || points.length === 0}
                onClick={onRunAll}
                title="Analyze every loaded image with the current points + config"
              >
                Run All ({images.length}){' '}
                {batchStale && Object.keys(batchResults).length > 0 && (
                  <span className="text-amber-200">(stale)</span>
                )}
              </button>
            )}
          </div>
        </div>
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <ImageCanvas
              image={image}
              points={points}
              results={results}
              selectedPointId={selectedPointId}
              pending={pending}
              roiWidth={config.roiWidth}
              roiHeight={config.roiHeight}
              onPending={onPending}
              onSelectPoint={setSelectedPointId}
              onMovePoint={onMovePoint}
              onResizeRoi={onResizeRoi}
              onMouseMoveImage={onMouseMoveImage}
              onRegister={onRegister}
            />
          </div>
          <StepNavigator
            total={images.length}
            currentIdx={currentIdx}
            currentName={images[currentIdx]?.name ?? null}
            onChange={setCurrentIdx}
          />
        </main>

        <aside className="flex w-[380px] flex-col gap-3 overflow-y-auto border-l border-slate-300 bg-slate-50 p-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              className="rounded bg-slate-700 px-2 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
              onClick={() => imageInputRef.current?.click()}
            >
              Load Images…
            </button>
            <SaveCsvMenu
              canCurrent={results.length > 0 && !!image}
              canAll={Object.keys(batchResults).length > 0}
              allCount={Object.keys(batchResults).length}
              allStale={batchStale}
              onCurrent={onSaveCsvCurrent}
              onAll={onSaveCsvAll}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs hover:bg-slate-100"
              onClick={onSaveConfig}
            >
              Save Config
            </button>
            <button
              className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs hover:bg-slate-100"
              onClick={() => configInputRef.current?.click()}
            >
              Load Config
            </button>
          </div>

          <SettingsPanel config={config} onChange={setConfig} />

          <div className="rounded border border-slate-200 bg-slate-900 p-3 text-slate-100">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] text-slate-400">Pending Rect</div>
                <div className="text-sm font-bold text-amber-300">
                  {pending
                    ? `(${pending.cx}, ${pending.cy})  ${pending.w}×${pending.h}`
                    : '(none)'}
                </div>
              </div>
              <button
                className="rounded bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-900 hover:bg-amber-400 disabled:opacity-40"
                disabled={!pending || !image}
                onClick={onRegister}
              >
                Register
              </button>
            </div>
          </div>

          <PointsPanel
            points={points}
            selectedId={selectedPointId}
            onSelect={setSelectedPointId}
            onDelete={onDeletePoint}
            onClear={onClearPoints}
            onCopy={onCopyPoint}
            onPaste={onPastePoint}
            canCopy={selectedPointId !== null}
            canPaste={clipboard !== null && !!image}
          />

          <SelectedResultPanel
            result={deferredSelectedResult}
            lowerThPercent={config.lowerThresholdPercent}
            upperThPercent={config.upperThresholdPercent}
          />

          <div className="flex flex-col gap-3">
            <ProfileGraph
              title="Horizontal Profile"
              single={deferredSelectedResult?.horizontal ?? null}
              lowerThPercent={config.lowerThresholdPercent}
              upperThPercent={config.upperThresholdPercent}
              axis="x"
            />
            <ProfileGraph
              title="Vertical Profile"
              single={deferredSelectedResult?.vertical ?? null}
              lowerThPercent={config.lowerThresholdPercent}
              upperThPercent={config.upperThresholdPercent}
              axis="y"
            />
          </div>

          <ResultsTable
            results={deferredResults}
            selectedId={selectedPointId}
            onSelect={setSelectedPointId}
          />

          <StepTrendGraph
            imageNames={imageNames}
            batchResults={batchResults}
            selectedPointId={selectedPointId}
            currentIdx={deferredCurrentIdx}
            stale={batchStale}
          />
        </aside>
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          loadImagesFromInput(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={configInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          onLoadConfig(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
    </div>
  );
}

export default App;
