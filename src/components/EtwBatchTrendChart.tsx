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
import type { BatchEtwCsvRow } from '../lib/etwCsv';
import { averageDistance, averageDistanceUm, type EtwMeasurementPoint } from '../lib/etwTypes';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, zoomPlugin, annotationPlugin);

const COLOR_H = '#4472c4';   // 파랑 (엑셀 기본)
const COLOR_V = '#ed7d31';   // 주황
const COLOR_AVG = '#a5a5a5'; // 회색

interface SeriesPoint {
  x: number;         // sequence idx 0..N-1
  y: number | null;
  heightUm: number;
  pointId: number;
  pointIdx: number;  // 0..points.length-1
  folderName: string;
}

interface Props {
  rows: BatchEtwCsvRow[];
  points: EtwMeasurementPoint[];
  defaultUnit?: 'px' | 'um';
}

export function EtwBatchTrendChart({ rows, points, defaultUnit = 'px' }: Props) {
  const chartRef = useRef<ChartJS<'line'> | null>(null);
  const [unit, setUnit] = useState<'px' | 'um'>(defaultUnit);
  const [visible, setVisible] = useState<{ h: boolean; v: boolean; avg: boolean }>({
    h: true, v: true, avg: true,
  });

  // 데이터 평탄화: sort by (pointIdx, heightUm)
  const { series, boundaries, sortedHeights } = useMemo(() => {
    // height 가 있는 row 만, 오름차순 정렬
    const sortedRows = [...rows]
      .filter((r) => r.heightUm !== null)
      .sort((a, b) => (a.heightUm! - b.heightUm!));
    const heights = sortedRows.map((r) => r.heightUm!);
    const hSeries: SeriesPoint[] = [];
    const vSeries: SeriesPoint[] = [];
    const avgSeries: SeriesPoint[] = [];
    const bounds: number[] = [];
    let idx = 0;
    for (let p = 0; p < points.length; p++) {
      const pid = points[p].id;
      if (p > 0) bounds.push(idx - 0.5);
      for (const row of sortedRows) {
        const r = row.results.find((x) => x.pointId === pid);
        const hVal = r
          ? unit === 'px'
            ? r.horizontal.distance
            : r.horizontal.distance * r.pixelWidthUm
          : null;
        const vVal = r
          ? unit === 'px'
            ? r.vertical.distance
            : r.vertical.distance * r.pixelHeightUm
          : null;
        const avgVal = r ? (unit === 'px' ? averageDistance(r) : averageDistanceUm(r)) : null;
        hSeries.push({
          x: idx, y: hVal, heightUm: row.heightUm!, pointId: pid, pointIdx: p, folderName: row.folderName,
        });
        vSeries.push({
          x: idx, y: vVal, heightUm: row.heightUm!, pointId: pid, pointIdx: p, folderName: row.folderName,
        });
        avgSeries.push({
          x: idx, y: avgVal, heightUm: row.heightUm!, pointId: pid, pointIdx: p, folderName: row.folderName,
        });
        idx++;
      }
    }
    return {
      series: { h: hSeries, v: vSeries, avg: avgSeries },
      boundaries: bounds,
      sortedHeights: heights,
    };
  }, [rows, points, unit]);

  const unitLabel = unit === 'px' ? 'px' : 'µm';

  const chartData = useMemo(() => ({
    datasets: [
      {
        label: `H_Distance(${unitLabel})`,
        data: series.h,
        borderColor: COLOR_H,
        backgroundColor: COLOR_H,
        pointRadius: 2,
        pointHoverRadius: 4,
        borderWidth: 1.5,
        tension: 0.2,
        spanGaps: true,
        hidden: !visible.h,
      },
      {
        label: `V_Distance(${unitLabel})`,
        data: series.v,
        borderColor: COLOR_V,
        backgroundColor: COLOR_V,
        pointRadius: 2,
        pointHoverRadius: 4,
        borderWidth: 1.5,
        tension: 0.2,
        spanGaps: true,
        hidden: !visible.v,
      },
      {
        label: `Average(${unitLabel})`,
        data: series.avg,
        borderColor: COLOR_AVG,
        backgroundColor: COLOR_AVG,
        pointRadius: 2,
        pointHoverRadius: 4,
        borderWidth: 1.8,
        tension: 0.2,
        spanGaps: true,
        hidden: !visible.avg,
      },
    ],
  }), [series, visible, unitLabel]);

  const options = useMemo<ChartOptions<'line'>>(() => {
    // boundary 마다 vertical line
    const annotations: Record<string, object> = {};
    boundaries.forEach((bx, i) => {
      annotations[`b${i}`] = {
        type: 'line',
        xMin: bx,
        xMax: bx,
        borderColor: '#cbd5e1',
        borderWidth: 1,
        borderDash: [3, 3],
      };
    });

    // x tick: height label sparse (시작 + 중간 + 끝 정도). 보내신 엑셀처럼 sequence 가 height 반복.
    const total = sortedHeights.length * points.length;
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: { display: false }, // 자체 체크박스
        tooltip: {
          callbacks: {
            title: (items) => {
              const raw = items[0].raw as SeriesPoint;
              return `point ${raw.pointId} · ${raw.heightUm.toFixed(0)} µm`;
            },
            label: (item) => {
              const raw = item.raw as SeriesPoint;
              return `${item.dataset.label}: ${raw.y != null ? raw.y.toFixed(3) : '–'}`;
            },
            afterBody: (items) => {
              const raw = items[0].raw as SeriesPoint;
              return [raw.folderName];
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
          min: -0.5,
          max: total - 0.5,
          title: { display: true, text: 'sequence (point × height)', font: { size: 11 } },
          ticks: {
            font: { size: 9 },
            callback: (v) => {
              const i = Math.round(v as number);
              if (i < 0 || i >= total) return '';
              const heightIdx = i % sortedHeights.length;
              return sortedHeights[heightIdx]?.toFixed(0) ?? '';
            },
            maxTicksLimit: 20,
            autoSkip: true,
          },
        },
        y: {
          type: 'linear',
          title: { display: true, text: `Distance (${unitLabel})`, font: { size: 11 } },
          ticks: { font: { size: 10 } },
        },
      },
    };
  }, [boundaries, sortedHeights, points.length, unitLabel]);

  useEffect(() => {
    chartRef.current?.resetZoom();
  }, [series.h.length, unit]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {(['h', 'v', 'avg'] as const).map((k) => {
            const label = k === 'h' ? 'H_Distance' : k === 'v' ? 'V_Distance' : 'Average';
            const color = k === 'h' ? COLOR_H : k === 'v' ? COLOR_V : COLOR_AVG;
            return (
              <label key={k} className="flex cursor-pointer select-none items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={visible[k]}
                  onChange={() => setVisible((prev) => ({ ...prev, [k]: !prev[k] }))}
                  className="h-3 w-3"
                  style={{ accentColor: color }}
                />
                <span
                  className="inline-block h-2 w-3 rounded-sm"
                  style={{ background: color, opacity: visible[k] ? 1 : 0.25 }}
                />
                <span className={visible[k] ? 'text-slate-700' : 'text-slate-400 line-through'}>
                  {label}({unitLabel})
                </span>
              </label>
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          {(['px', 'um'] as const).map((u) => (
            <button
              key={u}
              onClick={() => setUnit(u)}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                unit === u
                  ? 'border-slate-700 bg-slate-700 text-white'
                  : 'border-slate-300 hover:bg-slate-100'
              }`}
            >
              {u === 'px' ? 'px' : 'µm'}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Line ref={chartRef as never} data={chartData} options={options} />
      </div>
    </div>
  );
}
