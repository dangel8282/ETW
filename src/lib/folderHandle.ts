// File System Access API wrapper
// - showDirectoryPicker (per-id 마지막 시작 위치 자동 기억)
// - DirectoryHandle 을 IndexedDB 에 보관 → 다음 세션에서도 reload 가능
// - 권한은 user gesture 안에서 requestPermission

const DB_NAME = 'etw-folder-handles';
const STORE = 'handles';

interface WindowWithFsApi extends Window {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
}

export function fsApiAvailable(): boolean {
  return typeof (window as WindowWithFsApi).showDirectoryPicker === 'function';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

export async function loadHandle(key: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

export async function clearHandle(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* */ }
}

/** 권한 확인 + 필요 시 사용자에게 요청 (반드시 user-gesture 안에서 호출) */
export async function ensureReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  // queryPermission/requestPermission 은 모든 브라우저에서 같이 노출됨
  const opts = { mode: 'read' } as const;
  // @ts-expect-error — TS lib 에는 아직 없는 메서드
  const q: PermissionState = await handle.queryPermission(opts);
  if (q === 'granted') return true;
  // @ts-expect-error
  const r: PermissionState = await handle.requestPermission(opts);
  return r === 'granted';
}

/**
 * 폴더 안 모든 파일 recursive iterate. webkitRelativePath 모사.
 * 같은 depth 디렉토리의 entries() iteration 을 병렬 처리해 큰 폴더에서 큰 속도 향상.
 */
export async function collectFiles(
  root: FileSystemDirectoryHandle,
  onProgress?: (count: number) => void,
): Promise<File[]> {
  const out: File[] = [];

  async function processDirectory(
    dir: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<Array<[FileSystemDirectoryHandle, string]>> {
    const subDirs: Array<[FileSystemDirectoryHandle, string]> = [];
    const filePromises: Promise<File>[] = [];
    const filePaths: string[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') {
        subDirs.push([entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`]);
      } else if (entry.kind === 'file') {
        filePromises.push((entry as FileSystemFileHandle).getFile());
        filePaths.push(`${prefix}${entry.name}`);
      }
    }
    // getFile 들 병렬 await
    const files = await Promise.all(filePromises);
    for (let i = 0; i < files.length; i++) {
      try {
        Object.defineProperty(files[i], 'webkitRelativePath', {
          value: filePaths[i],
          configurable: true,
        });
      } catch { /* */ }
      out.push(files[i]);
    }
    if (onProgress) onProgress(out.length);
    return subDirs;
  }

  // BFS: 같은 depth 의 directory 들을 한꺼번에 처리
  let queue: Array<[FileSystemDirectoryHandle, string]> = [[root, `${root.name}/`]];
  while (queue.length > 0) {
    const next = await Promise.all(queue.map(([d, p]) => processDirectory(d, p)));
    queue = next.flat();
  }
  return out;
}

/** showDirectoryPicker — id 별로 시작 위치 기억. fsApiAvailable() 가 false 면 null 반환. */
export async function pickDirectoryWithApi(id: string): Promise<FileSystemDirectoryHandle | null> {
  const w = window as WindowWithFsApi;
  if (!w.showDirectoryPicker) return null;
  try {
    return await w.showDirectoryPicker({ id, mode: 'read' });
  } catch (e) {
    // 사용자가 취소했거나 권한 거부
    if ((e as DOMException)?.name === 'AbortError') return null;
    throw e;
  }
}
