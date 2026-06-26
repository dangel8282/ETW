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

interface Props {
  edgenessByRoi: number[][];           // [roiIdx][frameIdx]
  rois: NamedRoi[];
  bestFrames: (number | null)[];        // ROI별 best frame index (sub-frame, line marker)
  folderName: string | null;
}

export function EdgenessChart({ edgenessByRoi, rois, bestFrames, folderName }: Props) {
  const chartRef = useRef<ChartJS<'line'> | null>(null);

  const chartData = useMemo(() => {
    const len = edgenessByRoi[0]?.length ?? 0;
    return {
      datasets: rois.map((roi, i) => ({
        label: roi.name,
        data: Array.from({ length: len }, (_, j) => ({ x: j, y: edgenessByRoi[i]?.[j] ?? null })),
        borderColor: colorForRoiIdx(i),
        backgroundColor: colorForRoiIdx(i),
        pointRadius: 0,
        pointHoverRadius: 3,
        borderWidth: 1.8,
        tension: 0,
        spanGaps: true,
      })),
    };
  }, [edgenessByRoi, rois]);

  const options = useMemo<ChartOptions<'line'>>(() => {
    const annotations: Record<string, object> = {};
    bestFrames.forEach((bf, i) => {
      if (bf !== null && Number.isFinite(bf)) {
        annotations[`best${i}`] = {
          type: 'line',
          xMin: bf,
          xMax: bf,
          borderColor: colorForRoiIdx(i),
          borderWidth: 1,
          borderDash: [4, 4],
        };
      }
    });

    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `Frame ${items[0].label}`,
            label: (item) => {
              const raw = item.raw as { y: number | null };
              return `${item.dataset.label}: ${raw.y != null ? raw.y.toExponential(2) : '–'}`;
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
        annotation: { annotations },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Frame index', font: { size: 11 } },
          ticks: { font: { size: 10 } },
        },
        y: {
          type: 'linear',
          title: { display: false },
          ticks: {
            font: { size: 10 },
            callback: (v) => (typeof v === 'number' ? v.toExponential(1) : String(v)),
          },
        },
      },
    };
  }, [bestFrames]);

  // 새 폴더로 전환 시 줌 자동 리셋
  useEffect(() => {
    chartRef.current?.resetZoom();
  }, [folderName, edgenessByRoi.length]);

  return (
    <div className="h-full w-full">
      <Line ref={chartRef as never} data={chartData} options={options} />
    </div>
  );
}
