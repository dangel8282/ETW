import { useEffect } from 'react';

interface Props {
  total: number;
  currentIdx: number;
  currentName: string | null;
  onChange: (idx: number) => void;
}

export function StepNavigator({ total, currentIdx, currentName, onChange }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        if (currentIdx > 0) { e.preventDefault(); onChange(currentIdx - 1); }
      } else if (e.key === 'ArrowRight') {
        if (currentIdx < total - 1) { e.preventDefault(); onChange(currentIdx + 1); }
      } else if (e.key === 'Home') {
        e.preventDefault(); onChange(0);
      } else if (e.key === 'End') {
        e.preventDefault(); onChange(total - 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentIdx, total, onChange]);

  if (total <= 1) return null;

  return (
    <div className="flex items-center gap-2 border-t border-slate-300 bg-slate-100 px-3 py-2 text-xs">
      <button
        className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-200 disabled:opacity-40"
        disabled={currentIdx === 0}
        onClick={() => onChange(currentIdx - 1)}
        title="Previous (←)"
      >
        ◄
      </button>
      <input
        type="range"
        min={0}
        max={total - 1}
        value={currentIdx}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-cyan-600"
      />
      <button
        className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-200 disabled:opacity-40"
        disabled={currentIdx >= total - 1}
        onClick={() => onChange(currentIdx + 1)}
        title="Next (→)"
      >
        ►
      </button>
      <div className="min-w-[80px] text-right font-mono text-slate-700">
        {String(currentIdx + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </div>
      <div className="min-w-[120px] flex-shrink truncate text-slate-500" title={currentName ?? ''}>
        {currentName ?? ''}
      </div>
    </div>
  );
}
