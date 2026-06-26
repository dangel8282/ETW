import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NamedRoi } from '../lib/multiRoi';
import { colorForRoiIdx } from '../lib/multiRoi';

type HandleName = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type Interaction =
  | { kind: 'pan'; startSX: number; startSY: number; origPanX: number; origPanY: number }
  | { kind: 'new'; startImgX: number; startImgY: number; curImgX: number; curImgY: number }
  | { kind: 'move'; roiId: string; startImgX: number; startImgY: number; origX: number; origY: number }
  | { kind: 'resize'; roiId: string; handle: HandleName; origX: number; origY: number; origW: number; origH: number };

const HANDLE_PX_MAX = 8;
const HANDLE_PX_MIN = 4;
const HANDLE_MID_TH = 30;
const MIN_ROI = 4;
const DPR_CAP = 1.5;
const MIN_ZOOM = 1;
const MAX_ZOOM = 256;
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
  rois: NamedRoi[];
  selectedRoiId: string | null;
  onSelectRoi: (id: string | null) => void;
  onRoiChange: (id: string, roi: Pick<NamedRoi, 'x' | 'y' | 'width' | 'height'>) => void;
  onCreateRoi?: (roi: Pick<NamedRoi, 'x' | 'y' | 'width' | 'height'>) => void;
}

export function MultiRoiEditor({
  bitmap,
  imageName,
  rois,
  selectedRoiId,
  onSelectRoi,
  onRoiChange,
  onCreateRoi,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [hoverCursor, setHoverCursor] = useState<string>('crosshair');

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

  // 이미지 사이즈 변경 시 zoom/pan 리셋
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

  // Fit-to-width — 이미지 가로가 항상 캔버스 폭에 가득 차도록 (zoom 1 기준).
  // 매우 가로형 line-scan 이미지에서 좌우 전체를 한눈에 볼 수 있도록.
  const fitScale = (() => {
    if (!bitmap || containerSize.w === 0) return 1;
    return containerSize.w / bitmap.width;
  })();
  const scale = fitScale * zoom;
  const drawW = bitmap ? bitmap.width * scale : 0;
  const drawH = bitmap ? bitmap.height * scale : 0;
  const offsetX = (containerSize.w - drawW) / 2 + pan.x;
  const offsetY = (containerSize.h - drawH) / 2 + pan.y;

  // 가장자리가 캔버스 안쪽 못 들어오게 clamp
  useEffect(() => {
    if (!bitmap || containerSize.w === 0 || containerSize.h === 0) return;
    const halfX = Math.abs(containerSize.w - drawW) / 2;
    const halfY = Math.abs(containerSize.h - drawH) / 2;
    const x = Math.max(-halfX, Math.min(halfX, pan.x));
    const y = Math.max(-halfY, Math.min(halfY, pan.y));
    if (x !== pan.x || y !== pan.y) setPan({ x, y });
  }, [bitmap, containerSize, drawW, drawH, pan]);

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

    rois.forEach((roi, idx) => {
      const color = colorForRoiIdx(idx);
      const isSel = roi.id === selectedRoiId;
      const x = offsetX + roi.x * scale;
      const y = offsetY + roi.y * scale;
      const w = roi.width * scale;
      const h = roi.height * scale;
      ctx.strokeStyle = color;
      ctx.lineWidth = isSel ? 2.5 : 1.5;
      ctx.strokeRect(x, y, w, h);
      // 라벨
      ctx.fillStyle = color;
      ctx.font = `${isSel ? 'bold ' : ''}12px system-ui`;
      ctx.fillText(roi.name, x + 2, Math.max(12, y - 2));
      // 선택된 ROI 만 핸들
      if (isSel) {
        const minDim = Math.min(w, h);
        const hp = handlePxFor(minDim);
        const half = hp / 2;
        const showMids = minDim >= HANDLE_MID_TH;
        const corners: Array<[number, number]> = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        const mids: Array<[number, number]> = showMids
          ? [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]]
          : [];
        for (const [hx, hy] of [...corners, ...mids]) {
          ctx.fillStyle = 'white';
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.fillRect(hx - half, hy - half, hp, hp);
          ctx.strokeRect(hx - half, hy - half, hp, hp);
        }
      }
    });

    if (interaction?.kind === 'new') {
      const x0 = Math.min(interaction.startImgX, interaction.curImgX);
      const y0 = Math.min(interaction.startImgY, interaction.curImgY);
      const w0 = Math.abs(interaction.curImgX - interaction.startImgX);
      const h0 = Math.abs(interaction.curImgY - interaction.startImgY);
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(offsetX + x0 * scale, offsetY + y0 * scale, w0 * scale, h0 * scale);
    }
  }, [bitmap, rois, selectedRoiId, interaction, scale, drawW, drawH, offsetX, offsetY, containerSize]);

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

  function hitHandle(clientX: number, clientY: number, roi: NamedRoi): HandleName | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const x = offsetX + roi.x * scale;
    const y = offsetY + roi.y * scale;
    const w = roi.width * scale;
    const h = roi.height * scale;
    const minDim = Math.min(w, h);
    const hit = Math.max(HANDLE_PX_MIN, handlePxFor(minDim) * 0.9);
    const showMids = minDim >= HANDLE_MID_TH;
    const cands: Array<[HandleName, number, number]> = [
      ['nw', x, y], ['ne', x + w, y], ['se', x + w, y + h], ['sw', x, y + h],
    ];
    if (showMids) {
      cands.push(['n', x + w / 2, y], ['e', x + w, y + h / 2], ['s', x + w / 2, y + h], ['w', x, y + h / 2]);
    }
    for (const [name, hx, hy] of cands) {
      if (Math.abs(sx - hx) <= hit && Math.abs(sy - hy) <= hit) return name;
    }
    return null;
  }

  function roiAt(p: { x: number; y: number }): NamedRoi | null {
    for (const r of rois) {
      if (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height) return r;
    }
    return null;
  }

  function clampRoi(x: number, y: number, w: number, h: number) {
    if (!bitmap) return { x, y, width: w, height: h };
    const W = bitmap.width, H = bitmap.height;
    const nx = Math.max(0, Math.min(W - MIN_ROI, x));
    const ny = Math.max(0, Math.min(H - MIN_ROI, y));
    const nw = Math.max(MIN_ROI, Math.min(W - nx, w));
    const nh = Math.max(MIN_ROI, Math.min(H - ny, h));
    return { x: Math.round(nx), y: Math.round(ny), width: Math.round(nw), height: Math.round(nh) };
  }

  // RAF throttle
  const pendingRef = useRef<{ id: string; roi: ReturnType<typeof clampRoi> } | null>(null);
  const rafRef = useRef<number | null>(null);
  const scheduleChange = (id: string, roi: ReturnType<typeof clampRoi>) => {
    pendingRef.current = { id, roi };
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const p = pendingRef.current;
      if (p) {
        pendingRef.current = null;
        onRoiChange(p.id, p.roi);
      }
    });
  };
  const flushChange = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingRef.current) {
      const p = pendingRef.current;
      pendingRef.current = null;
      onRoiChange(p.id, p.roi);
    }
  };

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

  function onPointerDown(e: React.PointerEvent) {
    if (!bitmap) return;
    (e.target as Element).setPointerCapture(e.pointerId);

    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      const r = canvasRef.current!.getBoundingClientRect();
      setInteraction({
        kind: 'pan',
        startSX: e.clientX - r.left,
        startSY: e.clientY - r.top,
        origPanX: pan.x,
        origPanY: pan.y,
      });
      return;
    }
    if (e.button !== 0) return;

    // 선택된 ROI 의 핸들 hit 우선
    const sel = rois.find((r) => r.id === selectedRoiId);
    if (sel) {
      const h = hitHandle(e.clientX, e.clientY, sel);
      if (h) {
        setInteraction({
          kind: 'resize',
          roiId: sel.id,
          handle: h,
          origX: sel.x, origY: sel.y, origW: sel.width, origH: sel.height,
        });
        return;
      }
    }

    const p = screenToImage(e.clientX, e.clientY);
    if (!p) return;

    // 선택된 ROI 의 body — 이동
    if (sel && p.x >= sel.x && p.x <= sel.x + sel.width && p.y >= sel.y && p.y <= sel.y + sel.height) {
      setInteraction({
        kind: 'move',
        roiId: sel.id,
        startImgX: p.x, startImgY: p.y,
        origX: sel.x, origY: sel.y,
      });
      return;
    }

    // 다른 ROI 안 — 선택만
    const hit = roiAt(p);
    if (hit && hit.id !== selectedRoiId) {
      onSelectRoi(hit.id);
      return;
    }

    // 빈 영역 — 새 ROI 그리기 (onCreateRoi 가 있으면)
    if (onCreateRoi) {
      setInteraction({ kind: 'new', startImgX: p.x, startImgY: p.y, curImgX: p.x, curImgY: p.y });
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!interaction) {
      // hover cursor
      const sel = rois.find((r) => r.id === selectedRoiId);
      if (sel) {
        const hh = hitHandle(e.clientX, e.clientY, sel);
        if (hh) { setHoverCursor(HANDLE_CURSOR[hh]); return; }
      }
      const p = screenToImage(e.clientX, e.clientY);
      if (p && sel && p.x >= sel.x && p.x <= sel.x + sel.width && p.y >= sel.y && p.y <= sel.y + sel.height) {
        setHoverCursor('move');
      } else if (p && roiAt(p)) {
        setHoverCursor('pointer');
      } else {
        setHoverCursor('crosshair');
      }
      return;
    }

    if (interaction.kind === 'pan') {
      const r = canvasRef.current!.getBoundingClientRect();
      setPan({
        x: interaction.origPanX + (e.clientX - r.left - interaction.startSX),
        y: interaction.origPanY + (e.clientY - r.top - interaction.startSY),
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
      const roi = rois.find((r) => r.id === interaction.roiId);
      if (!roi) return;
      const dx = p.x - interaction.startImgX;
      const dy = p.y - interaction.startImgY;
      const next = clampRoi(interaction.origX + dx, interaction.origY + dy, roi.width, roi.height);
      scheduleChange(interaction.roiId, next);
      return;
    }
    if (interaction.kind === 'resize') {
      const { handle, origX, origY, origW, origH, roiId } = interaction;
      let L = origX, R = origX + origW, T = origY, B = origY + origH;
      if (handle.includes('w')) L = p.x;
      if (handle.includes('e')) R = p.x;
      if (handle.includes('n')) T = p.y;
      if (handle.includes('s')) B = p.y;
      if (handle === 'n' || handle === 's') { L = origX; R = origX + origW; }
      if (handle === 'e' || handle === 'w') { T = origY; B = origY + origH; }
      if (R - L < MIN_ROI) {
        if (handle.includes('w')) L = R - MIN_ROI; else R = L + MIN_ROI;
      }
      if (B - T < MIN_ROI) {
        if (handle.includes('n')) T = B - MIN_ROI; else B = T + MIN_ROI;
      }
      const next = clampRoi(Math.round(L), Math.round(T), Math.round(R - L), Math.round(B - T));
      scheduleChange(roiId, next);
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
        onCreateRoi?.(next);
      }
    } else if (interaction.kind === 'move' || interaction.kind === 'resize') {
      flushChange();
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
      <div className="flex items-center justify-between border-b border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200">
        <div>
          <span className="font-semibold">ROI Editor</span>
          {imageName && <span className="ml-2 text-slate-400">· preview: {imageName}</span>}
          {bitmap && (
            <span className="ml-2 text-slate-500">
              · {bitmap.width}×{bitmap.height}
            </span>
          )}
          {!bitmap && <span className="ml-2 text-slate-500">— load a folder to preview</span>}
        </div>
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
              >−</button>
              <button
                className="rounded px-2 py-0.5 font-mono hover:bg-slate-700"
                onClick={fitView}
                title="Fit (double-click image)"
              >{(zoom * 100).toFixed(0)}%</button>
              <button
                className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-700"
                onClick={() => zoomBy(1.25)}
                title="Zoom in"
              >+</button>
            </div>
            <div className="pointer-events-none absolute top-2 left-2 rounded bg-slate-800/70 px-2 py-1 text-[10px] text-slate-300">
              Wheel: zoom · Middle/Right drag: pan · Double-click: fit · Click ROI: select
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
