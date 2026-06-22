import { memo } from 'react';
import type { EtwMeasurementResult, EtwSingleResult } from '../lib/etwTypes';
import { averageDistance, averageDistanceUm, hvDifference, hvDifferenceUm } from '../lib/etwTypes';

interface Props {
  result: EtwMeasurementResult | null;
  lowerThPercent: number;
  upperThPercent: number;
}

const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '–');
const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : '–');
const pxUm = (px: number, um: number) => `${f3(px)} px (${f3(um)} µm)`;

function Section({ title, single, umPerPx, x10Label, x90Label }: {
  title: string;
  single: EtwSingleResult;
  umPerPx: number;
  x10Label: string;
  x90Label: string;
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 text-xs font-semibold text-slate-700">{title}</div>
      <div className="grid grid-cols-[110px_1fr] gap-y-0.5 pl-2 text-xs">
        <span className="text-slate-500">Start Level</span><span>{f2(single.startLevel)}</span>
        <span className="text-slate-500">End Level</span><span>{f2(single.endLevel)}</span>
        <span className="text-slate-500">{x10Label}</span><span>{f3(single.x10)} px</span>
        <span className="text-slate-500">{x90Label}</span><span>{f3(single.x90)} px</span>
        <span className="font-semibold text-slate-700">Distance</span>
        <span className="font-semibold">{pxUm(single.distance, single.distance * umPerPx)}</span>
      </div>
    </div>
  );
}

function SelectedResultPanelInner({ result, lowerThPercent, upperThPercent }: Props) {
  if (!result) {
    return (
      <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-400">
        Select a registered point to see its result
      </div>
    );
  }
  const lo = Math.round(lowerThPercent);
  const hi = Math.round(upperThPercent);
  return (
    <div className="rounded border border-slate-200 bg-white p-3">
      <div className="mb-2 text-sm font-bold">
        Point #{result.pointId} ({result.x}, {result.y})
      </div>
      <Section title="Horizontal" single={result.horizontal} umPerPx={result.pixelWidthUm} x10Label={`x${lo}`} x90Label={`x${hi}`} />
      <Section title="Vertical"   single={result.vertical}   umPerPx={result.pixelHeightUm} x10Label={`y${lo}`} x90Label={`y${hi}`} />
      <div className="mt-2 border-t border-slate-200 pt-2 text-xs">
        <div className="grid grid-cols-[110px_1fr] gap-y-0.5">
          <span className="text-slate-500">Average</span>
          <span>{pxUm(averageDistance(result), averageDistanceUm(result))}</span>
          <span className="text-slate-500">|H − V|</span>
          <span>{pxUm(hvDifference(result), hvDifferenceUm(result))}</span>
        </div>
      </div>
    </div>
  );
}

export const SelectedResultPanel = memo(SelectedResultPanelInner);
