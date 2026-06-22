import type { EtwConfig } from './etwTypes';
import { DEFAULT_CONFIG } from './etwTypes';

const STORAGE_KEY = 'etw_config_v1';

interface WsaConfigJson {
  ROIWidth?: number;
  ROIHeight?: number;
  LowerThresholdPercent?: number;
  UpperThresholdPercent?: number;
  PixelWidthUm?: number;
  PixelHeightUm?: number;
  Points?: Array<{ X: number; Y: number }>;
}

export function configToWsaJson(cfg: EtwConfig): WsaConfigJson {
  return {
    ROIWidth: cfg.roiWidth,
    ROIHeight: cfg.roiHeight,
    LowerThresholdPercent: cfg.lowerThresholdPercent,
    UpperThresholdPercent: cfg.upperThresholdPercent,
    PixelWidthUm: cfg.pixelWidthUm,
    PixelHeightUm: cfg.pixelHeightUm,
    Points: cfg.points.map((p) => ({ X: p.x, Y: p.y })),
  };
}

export function wsaJsonToConfig(json: WsaConfigJson): EtwConfig {
  return {
    roiWidth: json.ROIWidth ?? DEFAULT_CONFIG.roiWidth,
    roiHeight: json.ROIHeight ?? DEFAULT_CONFIG.roiHeight,
    lowerThresholdPercent: json.LowerThresholdPercent ?? DEFAULT_CONFIG.lowerThresholdPercent,
    upperThresholdPercent: json.UpperThresholdPercent ?? DEFAULT_CONFIG.upperThresholdPercent,
    pixelWidthUm: json.PixelWidthUm ?? DEFAULT_CONFIG.pixelWidthUm,
    pixelHeightUm: json.PixelHeightUm ?? DEFAULT_CONFIG.pixelHeightUm,
    points: (json.Points ?? []).map((p) => ({ x: p.X, y: p.Y })),
  };
}

export function loadConfigFromStorage(): EtwConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return wsaJsonToConfig(JSON.parse(raw) as WsaConfigJson);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfigToStorage(cfg: EtwConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configToWsaJson(cfg)));
  } catch {
    /* quota / disabled — ignore */
  }
}

export function downloadConfig(cfg: EtwConfig, filename = 'etw_config.json'): void {
  const blob = new Blob([JSON.stringify(configToWsaJson(cfg), null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function importConfigFile(file: File): Promise<EtwConfig> {
  const text = await file.text();
  return wsaJsonToConfig(JSON.parse(text) as WsaConfigJson);
}
