import { VirtualEntry } from "../types";
import {
  arrayBufferToString,
  guessMimeType,
  normalizeVaultPath,
  stringToArrayBuffer,
} from "../utils/pathUtils";

const DB_VERSION = 1;
const STORE_ENTRIES = "entries";
const STORE_CONTENTS = "contents";
const STORE_META = "meta";

export class VirtualVaultCache {
  private db: IDBDatabase | null = null;
  private entries = new Map<string, VirtualEntry>();
  private contents = new Map<string, ArrayBuffer>();
  private blobUrls = new Map<string, string>();
  private meta = new Map<string, string>();
  private dbName: string;

  constructor(vaultName: string) {
    const safeName = (vaultName || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
    this.dbName = `obsidian-gdrive-vault-cache-${safeName}`;
  }

  public async open(): Promise<void> {
    if (typeof indexedDB === "undefined") {
      // Headless / Node unit test fallback: operate purely in-memory
      return;
    }

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
          db.createObjectStore(STORE_ENTRIES, { keyPath: "path" });
        }
        if (!db.objectStoreNames.contains(STORE_CONTENTS)) {
          db.createObjectStore(STORE_CONTENTS);
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB database open failed"));
    });

    await this.loadFromIndexedDb();
  }

  private async loadFromIndexedDb(): Promise<void> {
    if (!this.db) return;

    // Load entries
    const storedEntries = await this.idbGetAll<VirtualEntry>(STORE_ENTRIES);
    for (const entry of storedEntries) {
      this.entries.set(entry.path, entry);
    }

    // Load contents
    const storedContents = await this.idbGetAllWithKeys<ArrayBuffer>(STORE_CONTENTS);
    for (const { key, value } of storedContents) {
      if (value instanceof ArrayBuffer) {
        this.contents.set(key, value);
        this.refreshBlobUrl(key, value);
      }
    }

    // Load meta
    const storedMeta = await this.idbGetAllWithKeys<string>(STORE_META);
    for (const { key, value } of storedMeta) {
      this.meta.set(key, value);
    }
  }

  public getEntry(path: string): VirtualEntry | undefined {
    return this.entries.get(normalizeVaultPath(path));
  }

  public getAllEntries(): VirtualEntry[] {
    return Array.from(this.entries.values());
  }

  public hasEntries(): boolean {
    return this.entries.size > 0;
  }

  public async setEntry(entry: VirtualEntry): Promise<void> {
    const normalized = normalizeVaultPath(entry.path);
    const normalizedEntry: VirtualEntry = { ...entry, path: normalized };
    this.entries.set(normalized, normalizedEntry);
    await this.idbPut(STORE_ENTRIES, normalizedEntry);
  }

  public async setEntriesBulk(newEntries: VirtualEntry[]): Promise<void> {
    for (const entry of newEntries) {
      const normalized = normalizeVaultPath(entry.path);
      this.entries.set(normalized, { ...entry, path: normalized });
    }
    if (!this.db) return;

    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE_ENTRIES, "readwrite");
      const store = tx.objectStore(STORE_ENTRIES);
      for (const entry of newEntries) {
        const normalized = normalizeVaultPath(entry.path);
        store.put({ ...entry, path: normalized });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
  }

  public async deleteEntry(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    this.entries.delete(normalized);
    this.contents.delete(normalized);
    this.revokeBlobUrl(normalized);
    await Promise.all([
      this.idbDelete(STORE_ENTRIES, normalized),
      this.idbDelete(STORE_CONTENTS, normalized),
    ]);
  }

  public getTextContent(path: string): string | undefined {
    const buf = this.contents.get(normalizeVaultPath(path));
    if (!buf) return undefined;
    return arrayBufferToString(buf);
  }

  public getBinaryContent(path: string): ArrayBuffer | undefined {
    const buf = this.contents.get(normalizeVaultPath(path));
    if (!buf) return undefined;
    // Return a defensive slice so callers cannot mutate cached buffer
    return buf.slice(0);
  }

  public async setTextContent(path: string, text: string): Promise<void> {
    const buffer = stringToArrayBuffer(text);
    await this.setBinaryContent(path, buffer);
  }

  public async setBinaryContent(path: string, data: ArrayBuffer): Promise<void> {
    const normalized = normalizeVaultPath(path);
    const copy = data.slice(0);
    this.contents.set(normalized, copy);
    this.refreshBlobUrl(normalized, copy);

    const existing = this.entries.get(normalized);
    if (existing) {
      existing.size = copy.byteLength;
      existing.contentCached = true;
      await this.idbPut(STORE_ENTRIES, existing);
    }

    await this.idbPut(STORE_CONTENTS, copy, normalized);
  }

  public getBlobUrl(path: string): string | undefined {
    const normalized = normalizeVaultPath(path);
    const existingUrl = this.blobUrls.get(normalized);
    if (existingUrl) return existingUrl;

    const buf = this.contents.get(normalized);
    if (buf) {
      return this.refreshBlobUrl(normalized, buf);
    }
    return undefined;
  }

  private refreshBlobUrl(normalizedPath: string, buffer: ArrayBuffer): string | undefined {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return undefined;
    }
    this.revokeBlobUrl(normalizedPath);
    // Prefer the extension-derived type (Drive may report a generic MIME type), since consumers
    // like react-inlinesvg validate that SVG blobs are served as `image/svg+xml`.
    const guessed = guessMimeType(normalizedPath);
    const mime =
      guessed !== "application/octet-stream"
        ? guessed
        : this.entries.get(normalizedPath)?.mimeType || guessed;
    const blob = new Blob([buffer], { type: mime });
    const url = URL.createObjectURL(blob);
    this.blobUrls.set(normalizedPath, url);
    return url;
  }

  private revokeBlobUrl(normalizedPath: string): void {
    const oldUrl = this.blobUrls.get(normalizedPath);
    if (oldUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(oldUrl);
    }
    this.blobUrls.delete(normalizedPath);
  }

  public getMeta(key: string): string | undefined {
    return this.meta.get(key);
  }

  public async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
    await this.idbPut(STORE_META, value, key);
  }

  public async clearAll(): Promise<void> {
    for (const path of this.blobUrls.keys()) {
      this.revokeBlobUrl(path);
    }
    this.entries.clear();
    this.contents.clear();
    this.meta.clear();

    if (!this.db) return;
    await Promise.all([
      this.idbClear(STORE_ENTRIES),
      this.idbClear(STORE_CONTENTS),
      this.idbClear(STORE_META),
    ]);
  }

  public close(): void {
    for (const path of this.blobUrls.keys()) {
      this.revokeBlobUrl(path);
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private idbPut(storeName: string, value: unknown, key?: IDBValidKey): Promise<void> {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      if (key !== undefined) {
        store.put(value, key);
      } else {
        store.put(value);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
  }

  private idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
  }

  private idbClear(storeName: string): Promise<void> {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
  }

  private idbGetAll<T>(storeName: string): Promise<T[]> {
    if (!this.db) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result || []) as T[]);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB getAll failed"));
    });
  }

  private idbGetAllWithKeys<T>(storeName: string): Promise<Array<{ key: string; value: T }>> {
    if (!this.db) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const results: Array<{ key: string; value: T }> = [];
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          results.push({ key: String(cursor.key), value: cursor.value as T });
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error("IndexedDB cursor failed"));
    });
  }
}
