import type { EtwMeasurementPoint } from '../lib/etwTypes';

interface Props {
  points: EtwMeasurementPoint[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onDelete: () => void;
  onClear: () => void;
  onCopy: () => void;
  onPaste: () => void;
  canCopy: boolean;
  canPaste: boolean;
}

export function PointsPanel({ points, selectedId, onSelect, onDelete, onClear, onCopy, onPaste, canCopy, canPaste }: Props) {
  return (
    <div className="rounded border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-700">Measurement Points ({points.length})</div>
        <div className="flex gap-1">
          <button
            className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
            disabled={!canCopy}
            onClick={onCopy}
            title="Copy selected point (Ctrl+C)"
          >
            Copy
          </button>
          <button
            className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
            disabled={!canPaste}
            onClick={onPaste}
            title="Paste at cursor (Ctrl+V)"
          >
            Paste
          </button>
          <button
            className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
            disabled={selectedId === null}
            onClick={onDelete}
          >
            Delete
          </button>
          <button
            className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
            disabled={points.length === 0}
            onClick={onClear}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="max-h-40 overflow-auto rounded border border-slate-200">
        {points.length === 0 ? (
          <div className="p-2 text-center text-xs text-slate-400">No points registered</div>
        ) : (
          <ul className="text-xs">
            {points.map((p) => (
              <li
                key={p.id}
                onClick={() => onSelect(p.id)}
                className={`cursor-pointer border-b border-slate-100 px-2 py-1 last:border-b-0 hover:bg-slate-50 ${
                  selectedId === p.id ? 'bg-cyan-100' : ''
                }`}
              >
                #{p.id} &nbsp; ({p.x}, {p.y})
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
