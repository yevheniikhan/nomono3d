// Minimal IndexedDB wrapper: scene drafts, model files, thumbnails.
// Any failure (private mode, quota limits) silently returns null.
const DB_NAME = 'nomono3d', VER = 1, STORES = ['drafts', 'blobs', 'thumbs'];
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    try {
      const rq = indexedDB.open(DB_NAME, VER);
      rq.onupgradeneeded = () => { const db = rq.result; for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
      rq.onblocked = () => res(null);
    } catch (e) { res(null); }
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then(db => new Promise(res => {
    if (!db) return res(null);
    try {
      const t = db.transaction(store, mode), s = t.objectStore(store);
      const rq = fn(s);
      t.oncomplete = () => res(rq ? rq.result : true);
      t.onerror = t.onabort = () => res(null);
    } catch (e) { res(null); }
  }));
}
export const idbGet = (store, key) => tx(store, 'readonly', s => s.get(key));
export const idbPut = (store, key, val) => tx(store, 'readwrite', s => s.put(val, key));
export const idbDel = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const idbKeys = (store) => tx(store, 'readonly', s => s.getAllKeys());
