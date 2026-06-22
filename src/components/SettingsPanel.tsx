import type { EtwConfig } from '../lib/etwTypes';

interface Props {
  config: EtwConfig;
  onChange: (cfg: EtwConfig) => void;
}

function NumField({
  label,
  value,
  step,
  min,
  onChange,
  fixed,
}: {
  label: string;
  value: number;
  step: number;
  min?: number;
  onChange: (v: number) => void;
  fixed?: number;
}) {
  return (
    <label className="flex items-center justify-between gap-1.5 text-xs">
      <span className="truncate text-slate-600">{label}</span>
      <input
        type="number"
        className="w-16 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-right text-xs focus:border-slate-500 focus:outline-none"
        value={fixed !== undefined ? Number(value.toFixed(fixed)) : value}
        step={step}
        min={min}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          onChange(v);
        }}
      />
    </label>
  );
}

export function SettingsPanel({ config, onChange }: Props) {
  const set = <K extends keyof EtwConfig>(key: K, v: EtwConfig[K]) =>
    onChange({ ...config, [key]: v });

  return (
    <div className="rounded border border-slate-200 bg-white p-3">
      <div className="mb-2 text-xs font-semibold text-slate-700">ROI / Threshold / Pixel Size</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <NumField label="W (px)" value={config.roiWidth} step={2} min={4}
          onChange={(v) => set('roiWidth', Math.max(4, Math.round(v)))} />
        <NumField label="H (px)" value={config.roiHeight} step={2} min={4}
          onChange={(v) => set('roiHeight', Math.max(4, Math.round(v)))} />
        <NumField label="Lower Th (%)" value={config.lowerThresholdPercent} step={1} min={0}
          onChange={(v) => set('lowerThresholdPercent', Math.max(0, Math.min(100, v)))} />
        <NumField label="Upper Th (%)" value={config.upperThresholdPercent} step={1} min={0}
          onChange={(v) => set('upperThresholdPercent', Math.max(0, Math.min(100, v)))} />
        <NumField label="Px W (µm)" value={config.pixelWidthUm} step={0.1} min={0.0001} fixed={3}
          onChange={(v) => set('pixelWidthUm', v)} />
        <NumField label="Px H (µm)" value={config.pixelHeightUm} step={0.1} min={0.0001} fixed={3}
          onChange={(v) => set('pixelHeightUm', v)} />
      </div>
    </div>
  );
}
