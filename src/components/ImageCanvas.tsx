import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { LoadedImage } from '../lib/etwImage';
import type { EtwMeasurementPoint, EtwMeasurementResult } from '../lib/etwTypes';

export interface PendingRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

interface Props {
  image: LoadedImage | null;
  points: EtwMeasurementPoint[];
  results: EtwMeasurementResult[];
  selectedPointId: number | null;
  pending: PendingRect | null;
  roiWidth: number;
  roiHeight: number;
  onPending: (rect: PendingRect | null) => void;
  onSelectPoint: (id: number | null) => void;
  onMovePoint: (id: number, x: number, y: number) => void;
  onResizeRoi: (w: number, h: number) => void;
  onMouseMoveImage?: (p: { x: number; y: number } | null) => void;
  onRegister?: () => void;
  emptyPlaceholder?: ReactNode;
}

type HandleName = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type Interaction =
  | { kind: 'pan'; startScreenX: number; startScreenY: number; origPanX: number; origPanY: number }
  | { kind: 'new'; startImgX: number; startImgY: number; curImgX: number; curImgY: number }
  | { kind: 'move'; pointId: number; startImgX: number; startImgY: number; origCx: number; origCy: number }
  | { kind: 'resize'; pointId: number; handle: HandleName; origCx: number; origCy: number; origW: number; origH: number };

const MIN_ZOOM = 1; // Fit이 최소 — 이보다 더 줌아웃 안 됨 (이미지가 캔버스보다 작아지지 않게)
const MAX_ZOOM = 64;
const DPR_CAP = 1.5;
const HANDLE_PX_MAX = 8;       // 큰 사각형일 때 핸들 크기
const HANDLE_PX_MIN = 4;       // 작은 사각형일 때
const HANDLE_MID_THRESHOLD = 30; // 화면 최소 변 < 이 값이면 변 중간 핸들 숨김 (move 용 가운데 공간 확보)
const MIN_ROI = 4;
// 사각형 크기에 비례한 핸들 크기. 화면상 변 길이의 ~35% (4~8 사이 clamp).
const handlePxFor = (minScreenDim: number) =>
  Math.max(HANDLE_PX_MIN, Math.min(HANDLE_PX_MAX, minScreenDim * 0.35));
const getDpr = () => Math.min(window.devicePixelRatio || 1, DPR_CAP);

const HANDLE_CURSOR: Record<HandleName, string> = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};

export function ImageCanvas({
  image,
  points,
  results,
  selectedPointId,
  pending,
  roiWidth,
  roiHeight,
  onPending,
  onSelectPoint,
  onMovePoint,
  onResizeRoi,
  onMouseMoveImage,
  onRegister,
  emptyPlaceholder,
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

  // 이미지 사이즈가 달라질 때만 zoom/pan 리셋. 같은 사이즈(시퀀스) 안에서는
  // 같은 위치를 계속 비교할 수 있도록 유지 — 추가 render도 안 일어남.
  const lastSizeRef = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!image) {
      lastSizeRef.current = null;
      return;
    }
    const cur = { w: image.bitmap.width, h: image.bitmap.height };
    const prev = lastSizeRef.current;
    lastSizeRef.current = cur;
    if (!prev || prev.w !== cur.w || prev.h !== cur.h) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [image]);

  const fitScale = (() => {
    if (!image || containerSize.w === 0 || containerSize.h === 0) return 1;
    return Math.min(containerSize.w / image.bitmap.width, containerSize.h / image.bitmap.height);
  })();
  const scale = fitScale * zoom;
  const drawW = image ? image.bitmap.width * scale : 0;
  const drawH = image ? image.bitmap.height * scale : 0;
  const offsetX = (containerSize.w - drawW) / 2 + pan.x;
  const offsetY = (containerSize.h - drawH) / 2 + pan.y;

  // 줌/팬 결과 이미지 가장자리가 캔버스 안쪽으로 넘어가지 않도록 clamp.
  // 큰 이미지 → 캔버스를 항상 가득 채움 / 작은 이미지 → 캔버스 안에서만 이동.
  useEffect(() => {
    if (!image || containerSize.w === 0 || containerSize.h === 0) return;
    const halfX = Math.abs(containerSize.w - drawW) / 2;
    const halfY = Math.abs(containerSize.h - drawH) / 2;
    const x = Math.max(-halfX, Math.min(halfX, pan.x));
    const y = Math.max(-halfY, Math.min(halfY, pan.y));
    if (x !== pan.x || y !== pan.y) setPan({ x, y });
  }, [image, containerSize, drawW, drawH, pan]);

  // Canvas raster 버퍼 사이즈 설정. canvas는 image가 있을 때만 mount 되므로
  // 첫 마운트 시 effect 발화시키기 위해 image도 deps에 포함.
  // (raster setter는 변경 없으면 no-op이라 image 교체로 인한 reset 비용은 0)
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
  }, [containerSize, image]);

  // Draw — image / markers / pending / drag
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || containerSize.w === 0 || containerSize.h === 0) return;
    const tDraw = performance.now();
    const dpr = getDpr();
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f172a'; // slate-900 — alpha:false 라 paint must cover
    ctx.fillRect(0, 0, containerSize.w, containerSize.h);

    ctx.imageSmoothingEnabled = scale < 1.5;
    ctx.drawImage(image.bitmap, offsetX, offsetY, drawW, drawH);

    // Registered points
    for (const p of points) {
      const x = offsetX + p.x * scale;
      const y = offsetY + p.y * scale;
      const w = roiWidth * scale;
      const h = roiHeight * scale;
      const isSelected = p.id === selectedPointId;
      ctx.strokeStyle = isSelected ? '#22d3ee' : '#34d399';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
      ctx.beginPath();
      ctx.moveTo(x - 5, y);
      ctx.lineTo(x + 5, y);
      ctx.moveTo(x, y - 5);
      ctx.lineTo(x, y + 5);
      ctx.stroke();
      ctx.fillStyle = isSelected ? '#22d3ee' : '#34d399';
      ctx.font = '12px system-ui';
      ctx.fillText(`#${p.id}`, x - w / 2 + 2, y - h / 2 - 2);
    }

    // Measurement lines + L10/L90 markers (after Run)
    const COLOR_LINE = '#fbbf24';
    const COLOR_L10 = '#10b981';
    const COLOR_L90 = '#ef4444';
    for (const r of results) {
      const isSelected = r.pointId === selectedPointId;
      const sx = offsetX + r.x * scale;
      const sy = offsetY + r.y * scale;
      ctx.globalAlpha = isSelected ? 1.0 : 0.45;
      ctx.strokeStyle = COLOR_LINE;
      ctx.lineWidth = isSelected ? 2 : 1;

      // Horizontal line: (cx, cy) → (cx + width − 1, cy)
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (r.width - 1) * scale, sy);
      ctx.stroke();
      // Vertical line: (cx, cy) → (cx, cy + height − 1)
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx, sy + (r.height - 1) * scale);
      ctx.stroke();

      // ROI 화면 크기에 따라 마커 점 크기도 축소. 작은 사각형에서 점이 사각형을 가리지 않게.
      const minDimScreen = Math.min(r.width * scale, r.height * scale);
      const dotRMax = isSelected ? 5 : 3.5;
      const dotR = Math.max(1.5, Math.min(dotRMax, minDimScreen * 0.12));
      const drawDot = (x: number, y: number, fill: string) => {
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1;
        ctx.stroke();
      };

      if (r.horizontal.isValid) {
        if (Number.isFinite(r.horizontal.x10)) drawDot(sx + r.horizontal.x10 * scale, sy, COLOR_L10);
        if (Number.isFinite(r.horizontal.x90)) drawDot(sx + r.horizontal.x90 * scale, sy, COLOR_L90);
      }
      if (r.vertical.isValid) {
        if (Number.isFinite(r.vertical.x10)) drawDot(sx, sy + r.vertical.x10 * scale, COLOR_L10);
        if (Number.isFinite(r.vertical.x90)) drawDot(sx, sy + r.vertical.x90 * scale, COLOR_L90);
      }
      ctx.globalAlpha = 1;
    }

    if (pending) {
      const x = offsetX + pending.cx * scale;
      const y = offsetY + pending.cy * scale;
      const w = pending.w * scale;
      const h = pending.h * scale;
      ctx.strokeStyle = '#facc15';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
      ctx.setLineDash([]);
    }

    if (interaction?.kind === 'new') {
      const x0 = offsetX + Math.min(interaction.startImgX, interaction.curImgX) * scale;
      const y0 = offsetY + Math.min(interaction.startImgY, interaction.curImgY) * scale;
      const w = Math.abs(interaction.curImgX - interaction.startImgX) * scale;
      const h = Math.abs(interaction.curImgY - interaction.startImgY) * scale;
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, w, h);
    }

    // 선택된 점에 핸들 표시. 사각형이 화면상 작으면 핸들도 작게,
    // 매우 작으면 변 중간 핸들 숨겨서 가운데 클릭(move)을 쉽게.
    if (selectedPointId !== null) {
      const sp = points.find((p) => p.id === selectedPointId);
      if (sp) {
        const cx = offsetX + sp.x * scale;
        const cy = offsetY + sp.y * scale;
        const W = roiWidth * scale;
        const H = roiHeight * scale;
        const minDim = Math.min(W, H);
        const handlePx = handlePxFor(minDim);
        const half = handlePx / 2;
        const showMids = minDim >= HANDLE_MID_THRESHOLD;
        const corners: Array<[number, number]> = [
          [cx - W / 2, cy - H / 2], [cx + W / 2, cy - H / 2],
          [cx + W / 2, cy + H / 2], [cx - W / 2, cy + H / 2],
        ];
        const mids: Array<[number, number]> = showMids
          ? [[cx, cy - H / 2], [cx + W / 2, cy], [cx, cy + H / 2], [cx - W / 2, cy]]
          : [];
        for (const [hx, hy] of [...corners, ...mids]) {
          ctx.fillStyle = 'white';
          ctx.strokeStyle = '#22d3ee';
          ctx.lineWidth = 1.5;
          ctx.fillRect(hx - half, hy - half, handlePx, handlePx);
          ctx.strokeRect(hx - half, hy - half, handlePx, handlePx);
        }
      }
    }
    const dt = performance.now() - tDraw;
    console.log(`[draw] ${dt.toFixed(1)}ms  img=${image.bitmap.width}×${image.bitmap.height} canvas=${canvas.width}×${canvas.height}`);
  }, [image, points, results, selectedPointId, pending, interaction, scale, drawW, drawH, offsetX, offsetY, containerSize, roiWidth, roiHeight]);

  function screenToImage(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas || !image) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const x = (mx - offsetX) / scale;
    const y = (my - offsetY) / scale;
    return {
      x: Math.max(0, Math.min(image.bitmap.width - 1, x)),
      y: Math.max(0, Math.min(image.bitmap.height - 1, y)),
    };
  }

  // Wheel zoom (non-passive — needs preventDefault)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onWheel(e: WheelEvent) {
      if (!image) return;
      e.preventDefault();
      const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const imgX = (mx - offsetX) / scale;
      const imgY = (my - offsetY) / scale;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
      const newScale = fitScale * newZoom;
      // mx, my should still map to imgX, imgY after the zoom change
      const newOffsetX = mx - imgX * newScale;
      const newOffsetY = my - imgY * newScale;
      const newPanX = newOffsetX - (containerSize.w - image.bitmap.width * newScale) / 2;
      const newPanY = newOffsetY - (containerSize.h - image.bitmap.height * newScale) / 2;
      setZoom(newZoom);
      setPan({ x: newPanX, y: newPanY });
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [image, zoom, fitScale, scale, offsetX, offsetY, containerSize]);

  // Screen-space hit test of the handles around the currently selected point.
  // Hit radius scales with handle size; mids hidden on small rects.
  function hitHandle(screenX: number, screenY: number): HandleName | null {
    if (selectedPointId === null) return null;
    const sp = points.find((p) => p.id === selectedPointId);
    if (!sp) return null;
    const cx = offsetX + sp.x * scale;
    const cy = offsetY + sp.y * scale;
    const W = roiWidth * scale;
    const H = roiHeight * scale;
    const minDim = Math.min(W, H);
    const hit = Math.max(HANDLE_PX_MIN, handlePxFor(minDim) * 0.9);
    const showMids = minDim >= HANDLE_MID_THRESHOLD;
    const corners: Array<[HandleName, number, number]> = [
      ['nw', cx - W / 2, cy - H / 2], ['ne', cx + W / 2, cy - H / 2],
      ['se', cx + W / 2, cy + H / 2], ['sw', cx - W / 2, cy + H / 2],
    ];
    const mids: Array<[HandleName, number, number]> = showMids
      ? [['n', cx, cy - H / 2], ['e', cx + W / 2, cy], ['s', cx, cy + H / 2], ['w', cx - W / 2, cy]]
      : [];
    for (const [name, hx, hy] of [...corners, ...mids]) {
      if (Math.abs(screenX - hx) <= hit && Math.abs(screenY - hy) <= hit) return name;
    }
    return null;
  }

  function pointAtImage(p: { x: number; y: number }): EtwMeasurementPoint | null {
    for (const pt of points) {
      if (Math.abs(p.x - pt.x) <= roiWidth / 2 && Math.abs(p.y - pt.y) <= roiHeight / 2) return pt;
    }
    return null;
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!image) return;
    (e.target as Element).setPointerCapture(e.pointerId);

    // Middle / right click → pan
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

    const canvasRect = canvasRef.current!.getBoundingClientRect();
    const screenX = e.clientX - canvasRect.left;
    const screenY = e.clientY - canvasRect.top;

    // 1) selected point's resize handle?
    const handle = hitHandle(screenX, screenY);
    if (handle && selectedPointId !== null) {
      const sp = points.find((p) => p.id === selectedPointId)!;
      setInteraction({
        kind: 'resize',
        pointId: sp.id,
        handle,
        origCx: sp.x,
        origCy: sp.y,
        origW: roiWidth,
        origH: roiHeight,
      });
      return;
    }

    const p = screenToImage(e.clientX, e.clientY);
    if (!p) return;

    // 2) selected point's body → move
    if (selectedPointId !== null) {
      const sp = points.find((pt) => pt.id === selectedPointId);
      if (sp && Math.abs(p.x - sp.x) <= roiWidth / 2 && Math.abs(p.y - sp.y) <= roiHeight / 2) {
        setInteraction({
          kind: 'move',
          pointId: sp.id,
          startImgX: p.x,
          startImgY: p.y,
          origCx: sp.x,
          origCy: sp.y,
        });
        return;
      }
    }

    // 3) other point's body → select
    const hit = pointAtImage(p);
    if (hit && hit.id !== selectedPointId) {
      onSelectPoint(hit.id);
      return;
    }

    // 4) empty → new ROI
    setInteraction({ kind: 'new', startImgX: p.x, startImgY: p.y, curImgX: p.x, curImgY: p.y });
  }

  function onPointerMove(e: React.PointerEvent) {
    onMouseMoveImage?.(screenToImage(e.clientX, e.clientY));
    // Update hover cursor when not interacting
    if (!interaction) {
      const canvasRect = canvasRef.current?.getBoundingClientRect();
      if (canvasRect) {
        const screenX = e.clientX - canvasRect.left;
        const screenY = e.clientY - canvasRect.top;
        const handle = hitHandle(screenX, screenY);
        if (handle) {
          setHoverCursor(HANDLE_CURSOR[handle]);
        } else {
          const p = screenToImage(e.clientX, e.clientY);
          if (p && selectedPointId !== null) {
            const sp = points.find((pt) => pt.id === selectedPointId);
            if (sp && Math.abs(p.x - sp.x) <= roiWidth / 2 && Math.abs(p.y - sp.y) <= roiHeight / 2) {
              setHoverCursor('move');
              return;
            }
          }
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
      onMovePoint(
        interaction.pointId,
        Math.round(interaction.origCx + dx),
        Math.round(interaction.origCy + dy),
      );
      return;
    }

    if (interaction.kind === 'resize') {
      const { handle, origCx, origCy, origW, origH, pointId } = interaction;
      const origL = origCx - origW / 2;
      const origR = origCx + origW / 2;
      const origT = origCy - origH / 2;
      const origB = origCy + origH / 2;
      let L = origL, R = origR, T = origT, B = origB;
      if (handle.includes('w')) L = p.x;
      if (handle.includes('e')) R = p.x;
      if (handle.includes('n')) T = p.y;
      if (handle.includes('s')) B = p.y;
      // 가로/세로 단일축 핸들은 다른 축 고정
      if (handle === 'n' || handle === 's') { L = origL; R = origR; }
      if (handle === 'e' || handle === 'w') { T = origT; B = origB; }
      // 좌우/상하 뒤집힘 방지 (최소 ROI 보장)
      if (R - L < MIN_ROI) {
        if (handle.includes('w')) L = R - MIN_ROI;
        else R = L + MIN_ROI;
      }
      if (B - T < MIN_ROI) {
        if (handle.includes('n')) T = B - MIN_ROI;
        else B = T + MIN_ROI;
      }
      const newW = Math.max(MIN_ROI, Math.round(R - L));
      const newH = Math.max(MIN_ROI, Math.round(B - T));
      const newCx = Math.round((L + R) / 2);
      const newCy = Math.round((T + B) / 2);
      if (newCx !== origCx || newCy !== origCy) onMovePoint(pointId, newCx, newCy);
      if (newW !== origW || newH !== origH) onResizeRoi(newW, newH);
      return;
    }
  }

  function onPointerUp() {
    if (!interaction) return;
    if (interaction.kind === 'new') {
      const w = Math.abs(interaction.curImgX - interaction.startImgX);
      const h = Math.abs(interaction.curImgY - interaction.startImgY);
      if (w >= MIN_ROI && h >= MIN_ROI) {
        const cx = Math.round(Math.min(interaction.startImgX, interaction.curImgX) + w / 2);
        const cy = Math.round(Math.min(interaction.startImgY, interaction.curImgY) + h / 2);
        onPending({ cx, cy, w: Math.round(w), h: Math.round(h) });
      }
    }
    setInteraction(null);
  }

  function fitView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function zoomBy(factor: number) {
    if (!image) return;
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
      x: newOffsetX - (containerSize.w - image.bitmap.width * newScale) / 2,
      y: newOffsetY - (containerSize.h - image.bitmap.height * newScale) / 2,
    });
  }

  const cursor =
    interaction?.kind === 'pan' ? 'grabbing' :
    interaction?.kind === 'move' ? 'move' :
    interaction?.kind === 'resize' ? HANDLE_CURSOR[interaction.handle] :
    hoverCursor;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-slate-900 select-none"
    >
      {image ? (
        <>
          <canvas
            ref={canvasRef}
            style={{ cursor }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => onMouseMoveImage?.(null)}
            onDoubleClick={fitView}
            onContextMenu={(e) => e.preventDefault()}
          />
          <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded bg-slate-800/90 px-2 py-1 text-xs text-slate-100 shadow-lg">
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
              title="Fit to view (double-click image)"
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
          {pending && onRegister && (() => {
            const rightX = offsetX + (pending.cx + pending.w / 2) * scale;
            const leftX = offsetX + (pending.cx - pending.w / 2) * scale;
            const topY = offsetY + (pending.cy - pending.h / 2) * scale;
            const BTN_W = 80, BTN_H = 26, GAP = 6;
            // 기본: 사각형 우측 외부, 사각형 top과 같은 높이
            let x = rightX + GAP;
            const y0 = topY;
            if (x + BTN_W > containerSize.w) x = leftX - BTN_W - GAP; // 캔버스 밖이면 왼쪽
            x = Math.max(GAP, Math.min(containerSize.w - BTN_W - GAP, x));
            const y = Math.max(GAP, Math.min(containerSize.h - BTN_H - GAP, y0));
            return (
              <button
                className="absolute z-20 rounded bg-amber-500 px-3 text-xs font-bold text-slate-900 shadow-lg hover:bg-amber-400"
                style={{ left: Math.round(x), top: Math.round(y), height: BTN_H }}
                onClick={onRegister}
                title="Register this rectangle as a measurement point"
              >
                Register
              </button>
            );
          })()}
        </>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-400">
          {emptyPlaceholder ?? 'Load an image to begin'}
        </div>
      )}
    </div>
  );
}
