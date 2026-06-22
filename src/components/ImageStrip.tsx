import { useEffect, useRef } from 'react';

interface Props {
  names: string[];
  currentIdx: number;
  analyzedCount: (name: string) => number | null;
  totalPoints: number;
  onSelect: (idx: number) => void;
}

export function ImageStrip({ names, currentIdx, analyzedCount, totalPoints, onSelect }: Props) {
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentIdx]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700">
        Images ({names.length})
      </div>
      <div className="flex-1 overflow-auto">
        {names.length === 0 ? (
          <div className="p-3 text-center text-xs text-slate-400">No images loaded</div>
        ) : (
          <ul className="text-xs">
            {names.map((name, i) => {
              const count = analyzedCount(name);
              const isCurrent = i === currentIdx;
              return (
                <li
                  key={`${i}-${name}`}
                  ref={isCurrent ? activeRef : undefined}
                  onClick={() => onSelect(i)}
                  className={`flex cursor-pointer items-center justify-between border-b border-slate-100 px-2 py-1.5 last:border-b-0 ${
                    isCurrent ? 'bg-cyan-100 font-medium text-slate-900' : 'hover:bg-slate-100 text-slate-700'
                  }`}
                  title={name}
                >
                  <span className="mr-2 truncate">
                    <span className="mr-1 text-slate-400">{String(i + 1).padStart(2, '0')}</span>
                    {name}
                  </span>
                  {count === null ? (
                    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">—</span>
                  ) : count === totalPoints && totalPoints > 0 ? (
                    <span className="rounded bg-emerald-200 px-1.5 py-0.5 text-[10px] text-emerald-800">✓{count}</span>
                  ) : (
                    <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] text-amber-800">{count}/{totalPoints}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
