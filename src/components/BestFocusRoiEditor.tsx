import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BestFocusRoi } from '../lib/etwBestFocus';

type HandleName = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type Interaction =
  | { kind: 'pan'; startScreenX: number; startScreenY: number; origPanX: number; origPanY: number }
  | { kind: 'new'; startImgX: number; startImgY: number; curImgX: number; curImgY: number }
  | { kind: 'move'; startImgX: number; startImgY: number; origX: number; origY: number }
  | { kind: 'resize'; handle: HandleName; origX: number; origY: number; origW: number; origH: number };

const HANDLE_PX_MAX = 8;
const HANDLE_PX_MIN = 4;
const HANDLE_MID_TH = 30;
const MIN_ROI = 4;
const DPR_CAP = 1.5;
const MIN_ZOOM = 1; // fit 이 최소
const MAX_ZOOM = 64;
const getDpr = () => Math.min(window.devicePixelRatio || 1, DPR_CAP);
const handlePxFor = (m: number) => Math.max(HANDLE_PX_MIN, Math.min(HANDLE_PX_MAX, m * 0.35));

const HANDLE_CURSOR: Record<HandleName, string> = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};

interface Props {
  bitmap: ImageBitmap | null;
  imageName: string | null;
  roi: BestFocusRoi;
  onRoiChange: (roi: BestFocusRoi) => void;
}

export function BestFocusRoiEditor({ bitmap, imageName, roi, onRoiChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [hoverCursor, setHoverCursor] = useState<string>('crosshair');

  // RAF throttle 로 부모 setRoi 빈도 제한 — 마우스 이벤트가 빈번해도 매 frame 1회만
  const onRoiChangeRef = useRef(onRoiChange);
  onRoiChangeRef.current = onRoiChange;
  const pendingRoiRef = useRef<BestFocusRoi | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const scheduleRoiChange = (next: BestFocusRoi) => {
    pendingRoiRef.current = next;
    if (rafIdRef.current != null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const p = pendingRoiRef.current;
      if (p) {
        pendingRoiRef.current = null;
        onRoiChangeRef.current(p);
      }
    });
  };
  const flushRoiChange = () => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (pendingRoiRef.current) {
      const p = pendingRoiRef.current;
      pendingRoiRef.current = null;
      onRoiChangeRef.current(p);
    }
  };

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setContainerSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setContainerSize({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);

  // 이미지 사이즈가 변하면 zoom/pan 리셋
  const lastSizeRef = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!bitmap) {
      lastSizeRef.current = null;
      return;
    }
    const cur = { w: bitmap.width, h: bitmap.height };
    const prev = lastSizeRef.current;
    lastSizeRef.current = cur;
    if (!prev || prev.w !== cur.w || prev.h !== cur.h) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [bitmap]);

  const fitScale = (() => {
    if (!bitmap || containerSize.w === 0 || containerSize.h === 0) return 1;
    return Math.min(containerSize.w / bitmap.width, containerSize.h / bitmap.height);
  })();
  const scale = fitScale * zoom;
  const drawW = bitmap ? bitmap.width * scale : 0;
  const drawH = bitmap ? bitmap.height * scale : 0;
  const offsetX = (containerSize.w - drawW) / 2 + pan.x;
  const offsetY = (containerSize.h - drawH) / 2 + pan.y;

  // 줌/팬 결과 이미지 가장자리가 캔버스 안으로 넘어오지 않도록 clamp
  useEffect(() => {
    if (!bitmap || containerSize.w === 0 || containerSize.h === 0) return;
    const halfX = Math.abs(containerSize.w - drawW) / 2;
    const halfY = Math.abs(containerSize.h - drawH) / 2;
    const x = Math.max(-halfX, Math.min(halfX, pan.x));
    const y = Math.max(-halfY, Math.min(halfY, pan.y));
    if (x !== pan.x || y !== pan.y) setPan({ x, y });
  }, [bitmap, containerSize, drawW, drawH, pan]);

  // canvas raster size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || containerSize.w === 0 || containerSize.h === 0) return;
    const dpr = getDpr();
    const targetW = Math.max(1, Math.round(containerSize.w * dpr));
    const targetH = Math.max(1, Math.round(containerSize.h * dpr));
    if (canvas.width !== targetW) canvas.width = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    canvas.style.width = `${containerSize.w}px`;
    canvas.style.height = `${containerSize.h}px`;
  }, [containerSize, bitmap]);

  // draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || containerSize.w === 0 || containerSize.h === 0) return;
    const dpr = getDpr();
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, containerSize.w, containerSize.h);

    if (!bitmap) return;
    ctx.imageSmoothingEnabled = scale < 1.5;
    ctx.drawImage(bitmap, offsetX, offsetY, drawW, drawH);

    // ROI rect
    const x = offsetX + roi.x * scale;
    const y = offsetY + roi.y * scale;
    const w = roi.width * scale;
    const h = roi.height * scale;
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    // center crosshair
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5);
    ctx.stroke();

    // 핸들
    const minDim = Math.min(w, h);
    const hp = handlePxFor(minDim);
    const half = hp / 2;
    const showMids = minDim >= HANDLE_MID_TH;
    const corners: Array<[number, number]> = [
      [x, y], [x + w, y], [x + w, y + h], [x, y + h],
    ];
    const mids: Array<[number, number]> = showMids
      ? [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]]
      : [];
    for (const [hx, hy] of [...corners, ...mids]) {
      ctx.fillStyle = 'white';
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.5;
      ctx.fillRect(hx - half, hy - half, hp, hp);
      ctx.strokeRect(hx - half, hy - half, hp, hp);
    }

    // drawing new ROI
    if (interaction?.kind === 'new') {
      const x0 = Math.min(interaction.startImgX, interaction.curImgX);
      const y0 = Math.min(interaction.startImgY, interaction.curImgY);
      const w0 = Math.abs(interaction.curImgX - interaction.startImgX);
      const h0 = Math.abs(interaction.curImgY - interaction.startImgY);
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(offsetX + x0 * scale, offsetY + y0 * scale, w0 * scale, h0 * scale);
    }
  }, [bitmap, roi, interaction, scale, drawW, drawH, offsetX, offsetY, containerSize]);

  function screenToImage(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left - offsetX) / scale;
    const y = (clientY - rect.top - offsetY) / scale;
    return {
      x: Math.max(0, Math.min(bitmap.width - 1, x)),
      y: Math.max(0, Math.min(bitmap.height - 1, y)),
    };
  }

  function hitHandle(clientX: number, clientY: number): HandleName | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    const x = offsetX + roi.x * scale;
    const y = offsetY + roi.y * scale;
    const w = roi.width * scale;
    const h = roi.height * scale;
    const minDim = Math.min(w, h);
    const hit = Math.max(HANDLE_PX_MIN, handlePxFor(minDim) * 0.9);
    const showMids = minDim >= HANDLE_MID_TH;
    const candidates: Array<[HandleName, number, number]> = [
      ['nw', x, y], ['ne', x + w, y], ['se', x + w, y + h], ['sw', x, y + h],
    ];
    if (showMids) {
      candidates.push(['n', x + w / 2, y], ['e', x + w, y + h / 2], ['s', x + w / 2, y + h], ['w', x, y + h / 2]);
    }
    for (const [name, hx, hy] of candidates) {
      if (Math.abs(sx - hx) <= hit && Math.abs(sy - hy) <= hit) return name;
    }
    return null;
  }

  // Wheel zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onWheel(e: WheelEvent) {
      if (!bitmap) return;
      e.preventDefault();
      const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const imgX = (mx - offsetX) / scale;
      const imgY = (my - offsetY) / scale;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
      const newScale = fitScale * newZoom;
      const newOffsetX = mx - imgX * newScale;
      const newOffsetY = my - imgY * newScale;
      const newPanX = newOffsetX - (containerSize.w - bitmap.width * newScale) / 2;
      const newPanY = newOffsetY - (containerSize.h - bitmap.height * newScale) / 2;
      setZoom(newZoom);
      setPan({ x: newPanX, y: newPanY });
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [bitmap, zoom, fitScale, scale, offsetX, offsetY, containerSize]);

  function clampRoi(x: number, y: number, w: number, h: number) {
    if (!bitmap) return { x, y, width: w, height: h };
    const W = bitmap.width, H = bitmap.height;
    const nx = Math.max(0, Math.min(W - MIN_ROI, x));
    const ny = Math.max(0, Math.min(H - MIN_ROI, y));
    const nw = Math.max(MIN_ROI, Math.min(W - nx, w));
    const nh = Math.max(MIN_ROI, Math.min(H - ny, h));
    return { x: Math.round(nx), y: Math.round(ny), width: Math.round(nw), height: Math.round(nh) };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!bitmap) return;
    (e.target as Element).setPointerCapture(e.pointerId);

    // 중간/우클릭 → 팬
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      const rect = canvasRef.current!.getBoundingClientRect();
      setInteraction({
        kind: 'pan',
        startScreenX: e.clientX - rect.left,
        startScreenY: e.clientY - rect.top,
        origPanX: pan.x,
        origPanY: pan.y,
      });
      return;
    }

    if (e.button !== 0) return;

    const handle = hitHandle(e.clientX, e.clientY);
    if (handle) {
      setInteraction({
        kind: 'resize',
        handle,
        origX: roi.x,
        origY: roi.y,
        origW: roi.width,
        origH: roi.height,
      });
      return;
    }

    const p = screenToImage(e.clientX, e.clientY);
    if (!p) return;

    if (p.x >= roi.x && p.x <= roi.x + roi.width && p.y >= roi.y && p.y <= roi.y + roi.height) {
      setInteraction({
        kind: 'move',
        startImgX: p.x,
        startImgY: p.y,
        origX: roi.x,
        origY: roi.y,
      });
      return;
    }

    setInteraction({ kind: 'new', startImgX: p.x, startImgY: p.y, curImgX: p.x, curImgY: p.y });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!interaction) {
      const h = hitHandle(e.clientX, e.clientY);
      if (h) setHoverCursor(HANDLE_CURSOR[h]);
      else {
        const p = screenToImage(e.clientX, e.clientY);
        if (p && p.x >= roi.x && p.x <= roi.x + roi.width && p.y >= roi.y && p.y <= roi.y + roi.height) {
          setHoverCursor('move');
        } else {
          setHoverCursor('crosshair');
        }
      }
      return;
    }

    if (interaction.kind === 'pan') {
      const rect = canvasRef.current!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setPan({
        x: interaction.origPanX + (mx - interaction.startScreenX),
        y: interaction.origPanY + (my - interaction.startScreenY),
      });
      return;
    }

    const p = screenToImage(e.clientX, e.clientY);
    if (!p) return;

    if (interaction.kind === 'new') {
      setInteraction({ ...interaction, curImgX: p.x, curImgY: p.y });
      return;
    }

    if (interaction.kind === 'move') {
      const dx = p.x - interaction.startImgX;
      const dy = p.y - interaction.startImgY;
      const next = clampRoi(interaction.origX + dx, interaction.origY + dy, roi.width, roi.height);
      if (next.x !== roi.x || next.y !== roi.y) scheduleRoiChange({ ...roi, x: next.x, y: next.y });
      return;
    }

    if (interaction.kind === 'resize') {
      const { handle, origX, origY, origW, origH } = interaction;
      let L = origX, R = origX + origW, T = origY, B = origY + origH;
      if (handle.includes('w')) L = p.x;
      if (handle.includes('e')) R = p.x;
      if (handle.includes('n')) T = p.y;
      if (handle.includes('s')) B = p.y;
      if (handle === 'n' || handle === 's') { L = origX; R = origX + origW; }
      if (handle === 'e' || handle === 'w') { T = origY; B = origY + origH; }
      if (R - L < MIN_ROI) {
        if (handle.includes('w')) L = R - MIN_ROI;
        else R = L + MIN_ROI;
      }
      if (B - T < MIN_ROI) {
        if (handle.includes('n')) T = B - MIN_ROI;
        else B = T + MIN_ROI;
      }
      const nx = Math.round(L), ny = Math.round(T);
      const nw = Math.max(MIN_ROI, Math.round(R - L));
      const nh = Math.max(MIN_ROI, Math.round(B - T));
      const next = clampRoi(nx, ny, nw, nh);
      if (next.x !== roi.x || next.y !== roi.y || next.width !== roi.width || next.height !== roi.height) {
        scheduleRoiChange(next);
      }
      return;
    }
  }

  function onPointerUp() {
    if (!interaction) return;
    if (interaction.kind === 'new') {
      const x0 = Math.min(interaction.startImgX, interaction.curImgX);
      const y0 = Math.min(interaction.startImgY, interaction.curImgY);
      const w = Math.abs(interaction.curImgX - interaction.startImgX);
      const h = Math.abs(interaction.curImgY - interaction.startImgY);
      if (w >= MIN_ROI && h >= MIN_ROI) {
        const next = clampRoi(x0, y0, w, h);
        onRoiChange(next);
      }
    } else {
      // move/resize 가 RAF throttle 된 마지막 값 flush
      flushRoiChange();
    }
    setInteraction(null);
  }

  function fitView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function zoomBy(factor: number) {
    if (!bitmap) return;
    const cx = containerSize.w / 2;
    const cy = containerSize.h / 2;
    const imgX = (cx - offsetX) / scale;
    const imgY = (cy - offsetY) / scale;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    const newScale = fitScale * newZoom;
    const newOffsetX = cx - imgX * newScale;
    const newOffsetY = cy - imgY * newScale;
    setZoom(newZoom);
    setPan({
      x: newOffsetX - (containerSize.w - bitmap.width * newScale) / 2,
      y: newOffsetY - (containerSize.h - bitmap.height * newScale) / 2,
    });
  }

  const cursor =
    interaction?.kind === 'pan' ? 'grabbing' :
    interaction?.kind === 'move' ? 'move' :
    interaction?.kind === 'resize' ? HANDLE_CURSOR[interaction.handle] :
    hoverCursor;

  return (
    <div className="flex h-full w-full flex-col bg-slate-900">
      <div className="border-b border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200">
        <span className="font-semibold">ROI Editor</span>
        {imageName && <span className="ml-2 text-slate-400">· preview: {imageName}</span>}
        {!bitmap && <span className="ml-2 text-slate-500">— load a folder to preview</span>}
      </div>
      <div ref={containerRef} className="relative flex-1 overflow-hidden select-none">
        {bitmap ? (
          <>
            <canvas
              ref={canvasRef}
              style={{ cursor }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={fitView}
              onContextMenu={(e) => e.preventDefault()}
            />
            <div className="absolute right-2 bottom-2 flex items-center gap-1 rounded bg-slate-800/90 px-2 py-1 text-xs text-slate-100 shadow-lg">
              <button
                className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-700"
                onClick={() => zoomBy(1 / 1.25)}
                title="Zoom out"
              >
                −
              </button>
              <button
                className="rounded px-2 py-0.5 font-mono hover:bg-slate-700"
                onClick={fitView}
                title="Fit (double-click image)"
              >
                {(zoom * 100).toFixed(0)}%
              </button>
              <button
                className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-700"
                onClick={() => zoomBy(1.25)}
                title="Zoom in"
              >
                +
              </button>
            </div>
            <div className="pointer-events-none absolute top-2 left-2 rounded bg-slate-800/70 px-2 py-1 text-[10px] text-slate-300">
              Wheel: zoom · Middle/Right drag: pan · Double-click: fit
            </div>
          </>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-500 text-sm">
            (no preview)
          </div>
        )}
      </div>
    </div>
  );
}
