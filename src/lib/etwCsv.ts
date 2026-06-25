import type { EtwMeasurementResult } from './etwTypes';
import { averageDistance, averageDistanceUm, hvDifference, hvDifferenceUm } from './etwTypes';

function buildHeader(lowerThPercent: number, upperThPercent: number): string {
  const lo = Math.round(lowerThPercent);
  const hi = Math.round(upperThPercent);
  return (
    'ImageName,ID,X,Y,Width(px),Height(px),Width(um),Height(um),PixelW(um/px),PixelH(um/px),' +
    `H_StartLevel,H_EndLevel,H_x${lo},H_x${hi},H_Distance(px),H_Distance(um),` +
    `V_StartLevel,V_EndLevel,V_y${lo},V_y${hi},V_Distance(px),V_Distance(um),` +
    'Average(px),Average(um),H-V(px),H-V(um)'
  );
}

const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : 'NaN');
const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : 'NaN');

function csvRow(imageName: string, r: EtwMeasurementResult): string {
  const h = r.horizontal;
  const v = r.vertical;
  const hUm = h.distance * r.pixelWidthUm;
  const vUm = v.distance * r.pixelHeightUm;
  return [
    escapeField(imageName),
    r.pointId,
    r.x,
    r.y,
    r.width,
    r.height,
    f3(r.width * r.pixelWidthUm),
    f3(r.height * r.pixelHeightUm),
    f3(r.pixelWidthUm),
    f3(r.pixelHeightUm),
    f2(h.startLevel),
    f2(h.endLevel),
    f3(h.x10),
    f3(h.x90),
    f3(h.distance),
    f3(hUm),
    f2(v.startLevel),
    f2(v.endLevel),
    f3(v.x10),
    f3(v.x90),
    f3(v.distance),
    f3(vUm),
    f3(averageDistance(r)),
    f3(averageDistanceUm(r)),
    f3(hvDifference(r)),
    f3(hvDifferenceUm(r)),
  ].join(',');
}

function escapeField(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function buildCsv(
  imageName: string,
  results: EtwMeasurementResult[],
  lowerThPercent: number,
  upperThPercent: number,
): string {
  const lines = [buildHeader(lowerThPercent, upperThPercent)];
  for (const r of results) lines.push(csvRow(imageName, r));
  return lines.join('\n') + '\n';
}

export function buildCsvMulti(
  rows: Array<{ imageName: string; results: EtwMeasurementResult[] }>,
  lowerThPercent: number,
  upperThPercent: number,
): string {
  const lines = [buildHeader(lowerThPercent, upperThPercent)];
  for (const { imageName, results } of rows) {
    for (const r of results) lines.push(csvRow(imageName, r));
  }
  return lines.join('\n') + '\n';
}

export interface BatchEtwCsvRow {
  folderName: string;
  heightUm: number | null;
  bestFrameRaw: number;
  bestFrameSub: number;
  bestImageName: string;
  results: EtwMeasurementResult[];
}

function buildBatchHeader(lowerThPercent: number, upperThPercent: number): string {
  return 'FolderName,HeightUm,BestFrameRaw,BestFrameSub,BestImageName,' + buildHeader(lowerThPercent, upperThPercent);
}

export function buildBatchEtwCsv(
  rows: BatchEtwCsvRow[],
  lowerThPercent: number,
  upperThPercent: number,
): string {
  const lines = [buildBatchHeader(lowerThPercent, upperThPercent)];
  for (const row of rows) {
    const prefix = [
      escapeField(row.folderName),
      row.heightUm == null ? '' : f3(row.heightUm),
      row.bestFrameRaw,
      f3(row.bestFrameSub),
      escapeField(row.bestImageName),
    ].join(',');
    for (const r of row.results) {
      lines.push(prefix + ',' + csvRow(row.bestImageName, r));
    }
  }
  return lines.join('\n') + '\n';
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
