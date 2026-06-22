import { useEffect, useRef, useState } from 'react';

interface Props {
  canCurrent: boolean;
  canAll: boolean;
  allCount: number;
  allStale: boolean;
  onCurrent: () => void;
  onAll: () => void;
}

export function SaveCsvMenu({ canCurrent, canAll, allCount, allStale, onCurrent, onAll }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const disabled = !canCurrent && !canAll;

  return (
    <div ref={rootRef} className="relative">
      <button
        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-40"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        Save CSV ▾
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 min-w-[180px] rounded border border-slate-300 bg-white shadow-lg">
          <button
            className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canCurrent}
            onClick={() => { onCurrent(); setOpen(false); }}
          >
            Current image
          </button>
          <button
            className="block w-full border-t border-slate-200 px-3 py-1.5 text-left text-xs hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canAll}
            onClick={() => { onAll(); setOpen(false); }}
          >
            All images <span className="text-slate-400">({allCount})</span>
            {allStale && <span className="ml-1 text-amber-600">stale</span>}
          </button>
        </div>
      )}
    </div>
  );
}
