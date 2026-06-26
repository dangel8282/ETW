import { useEffect, useMemo, useRef } from 'react';
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

export interface HeightTrendPoint {
  height: number;
  folderIdx: number;
  name: string;
  bestByRoi: (number | null)[];
}

interface Props {
  data: HeightTrendPoint[];
  rois: NamedRoi[];
  selectedHeight: number | null;
  onPointClick?: (folderIdx: number) => void;
}

export function HeightTrendChart({ data, rois, selectedHeight, onPointClick }: Props) {
  const chartRef = useRef<ChartJS<'line'> | null>(null);

  const chartData = useMemo(() => ({
    datasets: rois.map((roi, i) => ({
      label: roi.name,
      data: data.map((d) => ({ x: d.height, y: d.bestByRoi[i], folderIdx: d.folderIdx, name: d.name })),
      borderColor: colorForRoiIdx(i),
      backgroundColor: colorForRoiIdx(i),
      pointRadius: 2.5,
      pointHoverRadius: 4,
      borderWidth: 1.5,
      tension: 0.2,
      spanGaps: true,
    })),
  }), [data, rois]);

  const options = useMemo<ChartOptions<'line'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    interaction: { mode: 'nearest', intersect: false, axis: 'x' },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => {
            const it = items[0];
            const raw = it.raw as { x: number; name: string };
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
      annotation: selectedHeight !== null ? {
        annotations: {
          selLine: {
            type: 'line',
            xMin: selectedHeight,
            xMax: selectedHeight,
            borderColor: '#0891b2',
            borderWidth: 1.5,
            borderDash: [4, 4],
          },
        },
      } : undefined,
    },
    scales: {
      x: {
        type: 'linear',
        title: { display: true, text: 'Height (µm)', font: { size: 11 } },
        ticks: { font: { size: 10 } },
      },
      y: {
        type: 'linear',
        title: { display: true, text: 'Best step', font: { size: 11 } },
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

  // 데이터가 바뀌면 줌 자동 리셋 — 새 데이터의 전체 범위 보임
  useEffect(() => {
    chartRef.current?.resetZoom();
  }, [data.length, rois.length]);

  return (
    <div className="h-full w-full">
      <Line ref={chartRef as never} data={chartData} options={options} />
    </div>
  );
}
