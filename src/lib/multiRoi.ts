import type { BestFocusRoi } from './etwBestFocus';

export interface NamedRoi extends BestFocusRoi {
  id: string;
  name: string;
}

// 기본 색상 — 좌/중앙/우 (확장하면 더 추가)
const ROI_COLORS = [
  '#22d3ee', // cyan — Left
  '#f59e0b', // amber — Center
  '#ec4899', // pink — Right
  '#10b981', // emerald
  '#a78bfa', // violet
  '#ef4444', // red
];

export function colorForRoiIdx(idx: number): string {
  return ROI_COLORS[idx % ROI_COLORS.length];
}

/**
 * 파일명에서 step / focus 값 추출.
 *  'image-859.BMP' → 859
 *  'I0-7.BMP'      → 7
 *  'focus_050.bmp' → 50
 *  'X1Y2Z3.BMP'    → 3 (마지막 숫자)
 * 매칭 실패 시 null.
 */
export function parseStepFromFilename(name: string): number | null {
  const stem = name.replace(/\.[^.]+$/, '');
  // 마지막 연속 숫자 (정수 또는 소수)
  const m = stem.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
  return m ? parseFloat(m[1]) : null;
}

/** 이미지 폭에 비례해 좌/중앙/우 ROI 자동 배치 */
export function defaultMultiRois(imgW: number, imgH: number): NamedRoi[] {
  // ROI 크기: 이미지 세로의 ~80% 또는 256 중 작은 값. 세로가 작은 line scan 이미지에 맞춤.
  const size = Math.max(64, Math.min(512, Math.round(Math.min(imgW, imgH) * 0.8)));
  const w = Math.min(size, Math.floor(imgW / 4));
  const h = Math.min(size, imgH);
  const yCenter = Math.max(0, Math.floor((imgH - h) / 2));
  // X 위치: 좌측은 W*0.15 부근에서 ROI 시작, 우측은 W*0.85 - w 부근
  const leftX = Math.max(0, Math.round(imgW * 0.15 - w / 2));
  const centerX = Math.max(0, Math.round((imgW - w) / 2));
  const rightX = Math.max(0, Math.min(imgW - w, Math.round(imgW * 0.85 - w / 2)));
  return [
    { id: 'left', name: 'Left', x: leftX, y: yCenter, width: w, height: h },
    { id: 'center', name: 'Center', x: centerX, y: yCenter, width: w, height: h },
    { id: 'right', name: 'Right', x: rightX, y: yCenter, width: w, height: h },
  ];
}
