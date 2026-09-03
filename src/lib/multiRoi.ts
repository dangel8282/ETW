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

export interface FolderInput {
  name: string;
  files: File[];
}

const IMAGE_EXT_RE = /\.(bmp|png|jpe?g|tiff?|gif|webp)$/i;
const naturalSort = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const relPath = (f: File) =>
  (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';

/**
 * webkitRelativePath 로 서브폴더별 그룹화. 최상위 폴더 직속 파일은 제외.
 *
 * 두 가지 layout 을 지원한다:
 *  1. root/<sweep>/<frame>.BMP  — 서브폴더 하나가 sweep, 그 안 파일들이 frame
 *  2. root/<step>/image-0.BMP   — 서브폴더 하나가 step(=frame 1장). root 전체가 한 sweep
 * 2번은 모든 그룹의 파일이 1장인 것으로 감지해 root 하나로 flatten 한다.
 */
export function groupByFolder(filelist: FileList): FolderInput[] {
  const groups = new Map<string, File[]>();
  for (const f of Array.from(filelist)) {
    if (!IMAGE_EXT_RE.test(f.name)) continue;
    const parts = relPath(f).split('/');
    // depth < 3 (= 최상위 폴더 직속 파일) 은 무시 — 서브폴더만 처리.
    if (parts.length < 3) continue;
    const folderName = parts[parts.length - 2];
    if (!groups.has(folderName)) groups.set(folderName, []);
    groups.get(folderName)!.push(f);
  }
  const out: FolderInput[] = [];
  for (const [name, files] of groups) {
    files.sort((a, b) => naturalSort(a.name, b.name));
    out.push({ name, files });
  }
  out.sort((a, b) => naturalSort(a.name, b.name));

  // layout 2: 모든 서브폴더에 이미지가 1장뿐 → 서브폴더 자체가 frame
  if (out.length > 1 && out.every((g) => g.files.length === 1)) {
    const rootName = relPath(out[0].files[0]).split('/')[0] || 'root';
    return [{ name: rootName, files: out.map((g) => g.files[0]) }];
  }
  return out;
}

/**
 * frame 별 step 값. 기본은 파일명에서 파싱하고, 파일명이 step 을 구분하지
 * 못하면 (예: 모든 프레임이 image-0.BMP) 부모 폴더명에서 파싱한다.
 */
export function parseStepList(files: File[]): (number | null)[] {
  const byName = files.map((f) => parseStepFromFilename(f.name));
  if (new Set(byName).size > 1) return byName;
  return files.map((f) => {
    const parts = relPath(f).split('/');
    return parseStepFromFilename(parts[parts.length - 2] ?? '');
  });
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
