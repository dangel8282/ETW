import type { BestFocusResult } from './etwBestFocus';
import type { NamedRoi } from './multiRoi';

export interface MrbfFolderRow {
  folderName: string;
  heightUm: number | null;
  imageCount: number;
  bestByRoi: Array<{
    bestImageName: string;
    result: BestFocusResult | null;
  }>;
}

function escape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function bfPick(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n;
}

/**
 * 출력 포맷 (예: ROI 3개 — Left / Center / Right):
 *   FolderName, Left_BF, Center_BF, Right_BF,
 *   Center_BF-Left_BF, Center_BF-Right_BF,
 *   (Center_BF-Left_BF + Center_BF-Right_BF) / 2
 *
 * - BF = bestStepValue (raw, 소수점 3자리 출력)
 * - 차이는 idx 1 (중앙 ROI) 기준, Center − ROI
 * - ROI 가 1개면 BF 컬럼만, 2개면 차이 1개, 3개 이상이면 차이 N-1개 + 평균
 */
export function buildMultiRoiCsv(rois: NamedRoi[], rows: MrbfFolderRow[]): string {
  const header: string[] = ['FolderName'];
  for (const roi of rois) header.push(`${roi.name}_BF`);

  const centerIdx = rois.length >= 2 ? 1 : -1;
  const diffIndices: number[] = [];
  if (centerIdx >= 0) {
    for (let i = 0; i < rois.length; i++) {
      if (i === centerIdx) continue;
      diffIndices.push(i);
      header.push(`${rois[centerIdx].name}_BF-${rois[i].name}_BF`);
    }
    if (diffIndices.length >= 2) {
      const expr = diffIndices
        .map((i) => `${rois[centerIdx].name}_BF-${rois[i].name}_BF`)
        .join(' + ');
      header.push(`(${expr}) / ${diffIndices.length}`);
    }
  }

  const lines = [header.join(',')];
  const fmt = (n: number | null) => (n == null ? '' : n.toFixed(3));

  for (const r of rows) {
    const cells: string[] = [escape(r.folderName)];
    const bfValues: (number | null)[] = rois.map((_, i) =>
      bfPick(r.bestByRoi[i]?.result?.bestStepValue ?? null),
    );
    for (const v of bfValues) cells.push(fmt(v));

    if (centerIdx >= 0) {
      const center = bfValues[centerIdx];
      const diffs: (number | null)[] = [];
      for (const i of diffIndices) {
        const v = bfValues[i];
        const d = v != null && center != null ? center - v : null;
        diffs.push(d);
        cells.push(fmt(d));
      }
      if (diffIndices.length >= 2) {
        const validDiffs = diffs.filter((d): d is number => d != null);
        if (validDiffs.length === diffIndices.length) {
          const avg = validDiffs.reduce((a, b) => a + b, 0) / diffIndices.length;
          cells.push(fmt(avg));
        } else {
          cells.push('');
        }
      }
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n') + '\n';
}
