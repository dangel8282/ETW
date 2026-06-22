import { memo } from 'react';
import type { EtwMeasurementResult } from '../lib/etwTypes';
import { averageDistance, hvDifference } from '../lib/etwTypes';

interface Props {
  results: EtwMeasurementResult[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : '–');

function ResultsTableInner({ results, selectedId, onSelect }: Props) {
  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">
        All Results ({results.length})
      </div>
      <div className="max-h-48 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-100 text-slate-600">
            <tr>
              <th className="px-2 py-1 text-left">ID</th>
              <th className="px-2 py-1 text-right">X</th>
              <th className="px-2 py-1 text-right">Y</th>
              <th className="px-2 py-1 text-right">H</th>
              <th className="px-2 py-1 text-right">V</th>
              <th className="px-2 py-1 text-right">Avg</th>
              <th className="px-2 py-1 text-right">|H−V|</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-3 text-center text-slate-400">
                  No results yet — click Run after registering points
                </td>
              </tr>
            )}
            {results.map((r) => (
              <tr
                key={r.pointId}
                onClick={() => onSelect(r.pointId)}
                className={`cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50 ${
                  selectedId === r.pointId ? 'bg-cyan-100' : ''
                }`}
              >
                <td className="px-2 py-1">{r.pointId}</td>
                <td className="px-2 py-1 text-right">{r.x}</td>
                <td className="px-2 py-1 text-right">{r.y}</td>
                <td className="px-2 py-1 text-right">{f3(r.horizontal.distance)}</td>
                <td className="px-2 py-1 text-right">{f3(r.vertical.distance)}</td>
                <td className="px-2 py-1 text-right">{f3(averageDistance(r))}</td>
                <td className="px-2 py-1 text-right">{f3(hvDifference(r))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const ResultsTable = memo(ResultsTableInner);
