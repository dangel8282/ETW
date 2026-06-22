import { memo, useState } from 'react';
import {
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { EtwMeasurementResult } from '../lib/etwTypes';
import { averageDistance } from '../lib/etwTypes';

interface Props {
  imageNames: string[];
  batchResults: Record<string, EtwMeasurementResult[]>;
  selectedPointId: number | null;
  currentIdx: number;
  stale: boolean;
}

const fmt = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '–';

const LINE_DEFS = [
  { key: 'h' as const, label: 'H', color: '#2563eb', width: 1.5 },
  { key: 'v' as const, label: 'V', color: '#dc2626', width: 1.5 },
  { key: 'avg' as const, label: 'Avg', color: '#059669', width: 2 },
];

function StepTrendGraphInner({
  imageNames,
  batchResults,
  selectedPointId,
  currentIdx,
  stale,
}: Props) {
  const [visible, setVisible] = useState({ h: true, v: true, avg: true });
  const toggle = (k: 'h' | 'v' | 'avg') => setVisible((s) => ({ ...s, [k]: !s[k] }));
  const hasBatch = Object.keys(batchResults).length > 0;

  if (!hasBatch) {
    return (
      <div className="rounded border border-slate-200 bg-white p-3">
        <div className="mb-1 text-xs font-semibold text-slate-700">Step Trend</div>
        <div className="flex h-32 items-center justify-center text-xs text-slate-400">
          Press <span className="mx-1 rounded bg-slate-200 px-1.5 py-0.5">Run All</span> to populate
        </div>
      </div>
    );
  }
  if (selectedPointId === null) {
    return (
      <div className="rounded border border-slate-200 bg-white p-3">
        <div className="mb-1 text-xs font-semibold text-slate-700">Step Trend</div>
        <div className="flex h-32 items-center justify-center text-xs text-slate-400">
          Select a point to see trend
        </div>
      </div>
    );
  }

  const data = imageNames.map((name, i) => {
    const r = batchResults[name]?.find((x) => x.pointId === selectedPointId);
    return {
      i: i + 1,
      h: r ? r.horizontal.distance : null,
      v: r ? r.vertical.distance : null,
      avg: r ? averageDistance(r) : null,
    };
  });

  return (
    <div className="rounded border border-slate-200 bg-white p-3">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-slate-700">
          Step Trend · Point #{selectedPointId}
        </span>
        <div className="flex items-center gap-2">
          {LINE_DEFS.map((l) => (
            <label
              key={l.key}
              className="flex cursor-pointer items-center gap-1 select-none"
              title={`Toggle ${l.label}`}
            >
              <input
                type="checkbox"
                checked={visible[l.key]}
                onChange={() => toggle(l.key)}
                className="h-3 w-3 cursor-pointer"
                style={{ accentColor: l.color }}
              />
              <span style={{ color: l.color }} className="font-medium">
                {l.label}
              </span>
            </label>
          ))}
          {stale && <span className="text-amber-600">(stale)</span>}
        </div>
      </div>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
            <XAxis
              dataKey="i"
              type="number"
              domain={[1, imageNames.length]}
              allowDecimals={false}
              tick={{ fontSize: 10 }}
              stroke="#94a3b8"
            />
            <YAxis
              tick={{ fontSize: 10 }}
              stroke="#94a3b8"
              width={40}
              tickFormatter={(v) => Number(v).toFixed(1)}
            />
            <Tooltip
              contentStyle={{ fontSize: 11, padding: '4px 8px' }}
              labelFormatter={(label) => `Step ${label} · ${imageNames[Number(label) - 1] ?? ''}`}
              formatter={(value: unknown, name: unknown) => [fmt(value), String(name)]}
            />
            <ReferenceLine x={currentIdx + 1} stroke="#0891b2" strokeDasharray="3 3" />
            {LINE_DEFS.map((l) =>
              visible[l.key] ? (
                <Line
                  key={l.key}
                  type="monotone"
                  dataKey={l.key}
                  name={l.label}
                  stroke={l.color}
                  strokeWidth={l.width}
                  dot={{ r: 2 }}
                  isAnimationActive={false}
                  connectNulls
                />
              ) : null,
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export const StepTrendGraph = memo(StepTrendGraphInner);
