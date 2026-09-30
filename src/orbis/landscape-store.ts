/**
 * The picture the player uploaded, kept between visits.
 *
 * Uploading is work the player did, and it produced a file they chose from their own device. Making
 * them find it again after a reload — or after the tab was closed by a flaky lap — is the kind of
 * small tax that reads as the game forgetting them. So the file itself is kept, not the prepared
 * frame: `prepareLandscape` is pure canvas work over a `File`, so re-running it on the next mount
 * reproduces the same prepared landscape, the same seed and the same preview without storing a
 * megabyte of JPEG that would only have to be kept in step with the code that made it.
 *
 * IndexedDB rather than `localStorage`, and not because it is fashionable: `localStorage` is
 * synchronous, string-only, and capped at a few megabytes, and an upload may legitimately be 14 MB
 * of pixels (see `LANDSCAPE_MAX_BYTES`). IndexedDB stores the `File` itself — the browser keeps it
 * on disk, structured-cloned, so the bytes are not re-encoded and a large photo costs nothing on the
 * main thread.
 *
 * Everything here is best-effort. Private browsing, a blocked or disabled store, a quota error: each
 * degrades to "no stored picture", which is exactly what the game did before this existed. Nothing
 * in the run path reads this — `world.selectLandscape` is still the single source of truth for the
 * landscape in play — so a failed save is invisible rather than fatal.
 */

const DATABASE = "watchme-run";
const VERSION = 1;
const STORE = "landscape";
/** One record, one key: this is a single player's single picture, not a gallery. */
const KEY = "picture";

type StoredPicture = {
  file: File;
  savedAt: number;
};

function openDatabase(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(undefined);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE, VERSION);
    } catch {
      // Some browsers throw instead of erroring when storage is unavailable.
      resolve(undefined);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
}

/** One transaction, one request, resolved to its value — or undefined when anything went wrong. */
function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  return openDatabase().then(
    (database) =>
      new Promise<T | undefined>((resolve) => {
        if (!database) {
          resolve(undefined);
          return;
        }

        try {
          const transaction = database.transaction(STORE, mode);
          const request = operation(transaction.objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(undefined);
          transaction.onabort = () => resolve(undefined);
          transaction.oncomplete = () => database.close();
        } catch {
          database.close();
          resolve(undefined);
        }
      }),
  );
}

/** Keeps the picture for the next visit. Resolves when the write is committed, or when it failed. */
export async function saveLandscapeFile(file: File): Promise<void> {
  const record: StoredPicture = { file, savedAt: Date.now() };
  await transact("readwrite", (store) => store.put(record, KEY));
}

/**
 * The picture from the last visit, or undefined.
 *
 * A record whose file cannot be re-read is treated as absent and dropped, so a store left behind by
 * a half-written transaction cannot wedge the menu into a permanent "preparing" state.
 */
export async function loadLandscapeFile(): Promise<File | undefined> {
  const record = await transact<StoredPicture | undefined>(
    "readonly",
    (store) => store.get(KEY) as IDBRequest<StoredPicture | undefined>,
  );
  if (!record?.file || !(record.file instanceof File)) {
    if (record) await clearLandscapeFile();
    return undefined;
  }
  return record.file;
}

/** Forgets the picture. Called when the player removes it, so it does not come back on reload. */
export async function clearLandscapeFile(): Promise<void> {
  await transact("readwrite", (store) => store.delete(KEY));
}
