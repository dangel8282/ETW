export interface EtwSingleResult {
  startLevel: number;
  endLevel: number;
  x10: number;
  x90: number;
  distance: number;
  isValid: boolean;
  profile: number[];
  level10: number;
  level90: number;
  profileMin: number;
  profileMax: number;
}

export interface EtwMeasurementResult {
  pointId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidthUm: number;
  pixelHeightUm: number;
  horizontal: EtwSingleResult;
  vertical: EtwSingleResult;
}

export function averageDistance(r: EtwMeasurementResult): number {
  return 0.5 * (r.horizontal.distance + r.vertical.distance);
}

export function hvDifference(r: EtwMeasurementResult): number {
  return Math.abs(r.horizontal.distance - r.vertical.distance);
}

export function averageDistanceUm(r: EtwMeasurementResult): number {
  return 0.5 * (r.horizontal.distance * r.pixelWidthUm + r.vertical.distance * r.pixelHeightUm);
}

export function hvDifferenceUm(r: EtwMeasurementResult): number {
  return Math.abs(r.horizontal.distance * r.pixelWidthUm - r.vertical.distance * r.pixelHeightUm);
}

export interface EtwMeasurementPoint {
  id: number;
  x: number;
  y: number;
}

export interface EtwConfig {
  roiWidth: number;
  roiHeight: number;
  lowerThresholdPercent: number;
  upperThresholdPercent: number;
  pixelWidthUm: number;
  pixelHeightUm: number;
  points: Array<{ x: number; y: number }>;
}

export const DEFAULT_CONFIG: EtwConfig = {
  roiWidth: 50,
  roiHeight: 50,
  lowerThresholdPercent: 10,
  upperThresholdPercent: 90,
  pixelWidthUm: 5.85,
  pixelHeightUm: 5.85,
  points: [],
};

export function emptySingleResult(): EtwSingleResult {
  return {
    startLevel: 0, endLevel: 0, x10: NaN, x90: NaN, distance: 0,
    isValid: false, profile: [], level10: 0, level90: 0, profileMin: 0, profileMax: 0,
  };
}
