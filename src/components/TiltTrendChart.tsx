import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale,
  PointElement, LineElement,
  Tooltip, Legend,
  type ChartOptions,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import zoomPlugin from 'chartjs-plugin-zoom';
import annotationPlugin from 'chartjs-plugin-annotation';
import type { NamedRoi } from '../lib/multiRoi';
import { colorForRoiIdx } from '../lib/multiRoi';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, zoomPlugin, annotationPlugin);

export interface TiltTrendPoint {
  height: number;
  folderIdx: number;
  name: string;
  diffByRoi: (number | null)[];  // [i] = BF_center - BF_i, center 자리는 null
  avg: number | null;             // 비-center diff 들의 평균
}

interface Props {
  data: TiltTrendPoint[];
  rois: NamedRoi[];
  centerIdx: number;
  selectedHeight: number | null;
  onPointClick?: (folderIdx: number) => void;
}

const AVG_COLOR = '#0f172a'; // slate-900

export function TiltTrendChart({ data, rois, centerIdx, selectedHeight, onPointClick }: Props) {
  const chartRef = useRef<ChartJS<'line'> | null>(null);

  // dataset 정의 (visibility 빼고)
  const datasetSpecs = useMemo(() => {
    const out: Array<{
      label: string;
      color: string;
      kind: 'diff' | 'avg';
      sourceIdx: number; // diff 의 경우 ROI idx, avg 면 -1
      data: Array<{ x: number; y: number | null; folderIdx: number; name: string }>;
    }> = [];
    for (let i = 0; i < rois.length; i++) {
      if (i === centerIdx) continue;
      out.push({
        label: `${rois[centerIdx]?.name ?? 'C'} − ${rois[i].name}`,
        color: colorForRoiIdx(i),
        kind: 'diff',
        sourceIdx: i,
        data: data.map((d) => ({ x: d.height, y: d.diffByRoi[i], folderIdx: d.folderIdx, name: d.name })),
      });
    }
    out.push({
      label: 'avg',
      color: AVG_COLOR,
      kind: 'avg',
      sourceIdx: -1,
      data: data.map((d) => ({ x: d.height, y: d.avg, folderIdx: d.folderIdx, name: d.name })),
    });
    return out;
  }, [data, rois, centerIdx]);

  // 시리즈 visibility — checkbox 로 토글
  const [visible, setVisible] = useState<boolean[]>(() => datasetSpecs.map(() => true));
  useEffect(() => {
    setVisible((prev) => datasetSpecs.map((_, i) => prev[i] ?? true));
    // datasetSpecs 길이 / 순서만 영향. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetSpecs.length, rois.length, centerIdx]);

  const chartData = useMemo(() => ({
    datasets: datasetSpecs.map((spec, i) => ({
      label: spec.label,
      data: spec.data,
      borderColor: spec.color,
      backgroundColor: spec.color,
      pointRadius: spec.kind === 'avg' ? 3 : 2.5,
      pointHoverRadius: spec.kind === 'avg' ? 5 : 4,
      borderWidth: spec.kind === 'avg' ? 2.2 : 1.5,
      borderDash: spec.kind === 'avg' ? [6, 3] : undefined,
      tension: 0.2,
      spanGaps: true,
      hidden: visible[i] === false,
    })),
  }), [datasetSpecs, visible]);

  const options = useMemo<ChartOptions<'line'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    interaction: { mode: 'nearest', intersect: false, axis: 'x' },
    plugins: {
      legend: { display: false }, // 자체 체크박스 UI 로 대체
      tooltip: {
        callbacks: {
          title: (items) => {
            const raw = items[0].raw as { x: number; name: string };
            return `${raw.name} · ${raw.x.toFixed(2)} µm`;
          },
          label: (item) => {
            const raw = item.raw as { y: number | null };
            return `${item.dataset.label}: ${raw.y != null ? raw.y.toFixed(2) : '–'}`;
          },
        },
      },
      zoom: {
        zoom: {
          wheel: { enabled: true },
          drag: { enabled: false },
          pinch: { enabled: true },
          mode: 'xy',
        },
        pan: { enabled: true, mode: 'xy' },
        limits: {
          x: { min: 'original', max: 'original' },
          y: { min: 'original', max: 'original' },
        },
      },
      annotation: {
        annotations: {
          ...(selectedHeight !== null
            ? {
                selLine: {
                  type: 'line',
                  xMin: selectedHeight,
                  xMax: selectedHeight,
                  borderColor: '#0891b2',
                  borderWidth: 1.5,
                  borderDash: [4, 4],
                },
              }
            : {}),
          zeroLine: {
            type: 'line',
            yMin: 0,
            yMax: 0,
            borderColor: '#94a3b8',
            borderWidth: 1,
            borderDash: [2, 2],
          },
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        title: { display: true, text: 'Height (µm)', font: { size: 11 } },
        ticks: { font: { size: 10 } },
      },
      y: {
        type: 'linear',
        title: { display: true, text: 'BF diff (step)', font: { size: 11 } },
        ticks: { font: { size: 10 } },
      },
    },
    onClick: (_e, elements) => {
      if (!onPointClick || elements.length === 0) return;
      const el = elements[0];
      const ds = chartData.datasets[el.datasetIndex];
      const pt = ds.data[el.index] as { folderIdx?: number };
      if (typeof pt.folderIdx === 'number') onPointClick(pt.folderIdx);
    },
  }), [chartData, selectedHeight, onPointClick]);

  useEffect(() => {
    chartRef.current?.resetZoom();
  }, [data.length, rois.length, centerIdx]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
        {datasetSpecs.map((spec, i) => (
          <label key={spec.label} className="flex cursor-pointer items-center gap-1.5 select-none">
            <input
              type="checkbox"
              checked={visible[i] !== false}
              onChange={() =>
                setVisible((prev) => prev.map((v, j) => (j === i ? !v : v)))
              }
              className="h-3 w-3"
              style={{ accentColor: spec.color }}
            />
            <span
              className="inline-block h-2 w-3 rounded-sm"
              style={{
                background: spec.color,
                opacity: visible[i] === false ? 0.25 : 1,
                ...(spec.kind === 'avg'
                  ? { background: `repeating-linear-gradient(90deg, ${spec.color} 0 6px, transparent 6px 9px)` }
                  : {}),
              }}
            />
            <span
              className={visible[i] === false ? 'text-slate-400 line-through' : 'text-slate-700'}
            >
              {spec.label}
            </span>
          </label>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <Line ref={chartRef as never} data={chartData} options={options} />
      </div>
    </div>
  );
}
