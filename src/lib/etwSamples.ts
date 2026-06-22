// public/samples/manifest.json: ["img1.jpg", "img2.jpg", ...]
// 또는 { "images": ["img1.jpg", ...] }
// Vite의 BASE_URL을 사용해 어느 path에 배포되든 동작.

interface ManifestObject {
  images?: string[];
}

export async function fetchSampleImages(): Promise<File[]> {
  const base = import.meta.env.BASE_URL || './';
  const manifestUrl = `${base}samples/manifest.json`;
  const manifestRes = await fetch(manifestUrl);
  if (!manifestRes.ok) {
    throw new Error(`Sample manifest not found at ${manifestUrl}`);
  }
  const parsed: unknown = await manifestRes.json();
  const names: string[] = Array.isArray(parsed)
    ? (parsed as string[])
    : ((parsed as ManifestObject).images ?? []);
  if (names.length === 0) throw new Error('Sample manifest is empty');

  const files: File[] = [];
  for (const name of names) {
    const url = `${base}samples/${name}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const blob = await res.blob();
      files.push(new File([blob], name, { type: blob.type }));
    } catch {
      /* skip missing */
    }
  }
  if (files.length === 0) throw new Error('No sample images could be loaded');
  return files;
}
