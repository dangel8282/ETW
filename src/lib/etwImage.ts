import type { GrayscaleImage } from './etwAnalyzer';
import { imageDataToGrayscale } from './etwAnalyzer';

export interface LoadedImage {
  gray: GrayscaleImage;
  bitmap: ImageBitmap;
  name: string;
}

export async function loadImageFile(file: File | Blob, name?: string): Promise<LoadedImage> {
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const gray = imageDataToGrayscale(imageData);
  return {
    gray,
    bitmap,
    name: name ?? (file instanceof File ? file.name : 'image'),
  };
}
