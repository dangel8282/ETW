import { memo } from 'react';
import { ComposedChart, Line, ReferenceLine, ReferenceDot, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { EtwSingleResult } from '../lib/etwTypes';

// 점선 기준선 라벨 — 그래프 우측 끝, 점선 바로 위에 텍스트만
function LevelLineLabel({ viewBox, text, color }: {
  viewBox?: { x?: number; y?: number; width?: number; height?: number };
  text: string;
  color: string;
}) {
  if (!viewBox) return null;
  const fontSize = 10;
  const lineY = viewBox.y ?? 0;
  const rightX = (viewBox.x ?? 0) + (viewBox.width ?? 0) - 4;
  return (
    <text
      x={rightX}
      y={lineY - 3}
      fontSize={fontSize}
      fill={color}
      textAnchor="end"
      style={{ fontFamily: 'system-ui, sans-serif' }}
    >
      {text}
    </text>
  );
}

interface Props {
  title: string;
  single: EtwSingleResult | null;
  lowerThPercent: number;
  upperThPercent: number;
  axis: 'x' | 'y';
}

function ProfileGraphInner({ title, single, lowerThPercent, upperThPercent, axis }: Props) {
  const loLabel = `${axis}${Math.round(lowerThPercent)}`;
  const hiLabel = `${axis}${Math.round(upperThPercent)}`;
  if (!single || single.profile.length < 4) {
    return (
      <div>
        <div className="mb-1 text-xs font-semibold text-slate-700">{title}</div>
        <div className="flex h-32 items-center justify-center rounded border border-slate-200 bg-white text-xs text-slate-400">
          (no profile)
        </div>
      </div>
    );
  }
  const data = single.profile.map((v, i) => ({ i, v }));
  const range = single.profileMax - single.profileMin;
  const pad = Math.max(1, range * 0.1);
  const yMin = single.profileMin - pad;
  const yMax = single.profileMax + pad;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-semibold text-slate-700">{title}</span>
        <span className="text-slate-500">
          ETW = {Number.isFinite(single.distance) ? single.distance.toFixed(3) : '–'} px
        </span>
      </div>
      <div className="h-32 rounded border border-slate-200 bg-white">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
            <XAxis dataKey="i" type="number" domain={[0, data.length - 1]} tick={{ fontSize: 10 }} stroke="#94a3b8"
              tickFormatter={(v) => Number(v).toFixed(1)} />
            <YAxis domain={[yMin, yMax]} tick={{ fontSize: 10 }} stroke="#94a3b8" width={40}
              tickFormatter={(v) => Number(v).toFixed(1)} />
            <Tooltip
              contentStyle={{ fontSize: 11, padding: '4px 8px' }}
              labelFormatter={(label) => `i=${label}`}
              formatter={(value) => (typeof value === 'number' ? value.toFixed(2) : String(value))}
            />
            <ReferenceLine
              y={single.level10}
              stroke="#94a3b8"
              strokeDasharray="3 3"
              label={(props) => (
                <LevelLineLabel
                  viewBox={props.viewBox as { x?: number; y?: number; width?: number; height?: number }}
                  text={`${loLabel} = ${single.level10.toFixed(1)}`}
                  color="#10b981"
                />
              )}
            />
            <ReferenceLine
              y={single.level90}
              stroke="#94a3b8"
              strokeDasharray="3 3"
              label={(props) => (
                <LevelLineLabel
                  viewBox={props.viewBox as { x?: number; y?: number; width?: number; height?: number }}
                  text={`${hiLabel} = ${single.level90.toFixed(1)}`}
                  color="#ef4444"
                />
              )}
            />
            {Number.isFinite(single.x10) && (
              <ReferenceLine x={single.x10} stroke="#94a3b8" strokeDasharray="3 3" />
            )}
            {Number.isFinite(single.x90) && (
              <ReferenceLine x={single.x90} stroke="#94a3b8" strokeDasharray="3 3" />
            )}
            {Number.isFinite(single.x10) && (
              <ReferenceDot x={single.x10} y={single.level10} r={4} fill="#10b981" stroke="white" />
            )}
            {Number.isFinite(single.x90) && (
              <ReferenceDot x={single.x90} y={single.level90} r={4} fill="#ef4444" stroke="white" />
            )}
            <Line type="monotone" dataKey="v" stroke="#2563eb" dot={false} isAnimationActive={false} strokeWidth={1.5} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export const ProfileGraph = memo(ProfileGraphInner);
