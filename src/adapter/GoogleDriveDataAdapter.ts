import { DataAdapter, DataWriteOptions, ListedFiles, Stat } from "obsidian";
import { VirtualVaultCache } from "../cache/IndexedDbCache";
import { DriveClient, DRIVE_FOLDER_MIME } from "../drive/DriveClient";
import { GoogleDriveSettings, SyncState, VirtualEntry } from "../types";
import {
  arrayBuffersEqual,
  arrayBufferToString,
  concatArrayBuffers,
  driveMarkdownToObsidian,
  getBaseName,
  getParentPath,
  guessMimeType,
  isConfigOrInternalPath,
  isMarkdownFilePath,
  isSyncableConfigPath,
  isTextFilePath,
  normalizeVaultPath,
  obsidianMarkdownToDrive,
  stringToArrayBuffer,
} from "../utils/pathUtils";

export type ObsidianVaultRawEvent =
  | { type: "folder-created"; path: string }
  | {
      type: "file-created";
      path: string;
      stat: { ctime: number; mtime: number; size: number };
    }
  | {
      type: "modified";
      path: string;
      stat: { ctime: number; mtime: number; size: number };
      remote?: boolean;
    }
  | { type: "file-removed"; path: string }
  | { type: "folder-removed"; path: string }
  | { type: "renamed"; newPath: string; oldPath: string };

export class GoogleDriveDataAdapter implements DataAdapter {
  private writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlightDownloads = new Map<string, Promise<ArrayBuffer>>();
  private folderCreationLocks = new Map<string, Promise<string>>();
  private activeUploads = 0;
  public files: Record<string, { type: "file" | "folder"; realpath: string }> = {
    "/": { type: "folder", realpath: "/" },
  };

  constructor(
    public readonly baseAdapter: DataAdapter,
    public readonly cache: VirtualVaultCache,
    private readonly driveClient: DriveClient,
    private readonly getSettings: () => GoogleDriveSettings,
    private readonly configDir: string,
    private readonly onSyncStateChange?: (state: SyncState, detail?: string) => void,
    private readonly onVaultEvent?: (evt: ObsidianVaultRawEvent) => void
  ) {}

  /**
   * Wraps this adapter in a JavaScript Proxy so any undocumented/internal properties
   * or methods accessed by Obsidian gracefully fall back to the underlying platform adapter
   * if not defined on GoogleDriveDataAdapter.
   */
  public createProxiedAdapter(): DataAdapter {
    return new Proxy(this, {
      get(target: GoogleDriveDataAdapter, prop: keyof DataAdapter, receiver: unknown): unknown {
        if (prop in target) {
          const val = Reflect.get(target, prop, receiver) as unknown;
          return typeof val === "function" ? (val as (...args: unknown[]) => unknown).bind(target) : val;
        }
        const base = target.baseAdapter;
        const baseVal = base[prop];
        return typeof baseVal === "function" ? (baseVal as (...args: unknown[]) => unknown).bind(base) : baseVal;
      },
    });
  }

  private shouldUseBaseAdapter(normalizedPath: string): boolean {
    return isConfigOrInternalPath(normalizedPath, this.configDir);
  }

  private shouldSyncConfigPath(normalizedPath: string): boolean {
    return (
      Boolean(this.getSettings().syncConfigDir) &&
      isSyncableConfigPath(normalizedPath, this.configDir)
    );
  }

  public getName(): string {
    return this.baseAdapter.getName();
  }

  public getBasePath(): string {
    const anyBase = this.baseAdapter as DataAdapter & { getBasePath?: () => string };
    return typeof anyBase.getBasePath === "function" ? anyBase.getBasePath() : "";
  }

  public getFullPath(normalizedPath: string): string {
    const anyBase = this.baseAdapter as DataAdapter & { getFullPath?: (p: string) => string };
    if (typeof anyBase.getFullPath === "function") {
      return anyBase.getFullPath(normalizedPath);
    }
    return normalizedPath;
  }

  public getFilePath(normalizedPath: string): string {
    const anyBase = this.baseAdapter as DataAdapter & { getFilePath?: (p: string) => string };
    if (typeof anyBase.getFilePath === "function") {
      return anyBase.getFilePath(normalizedPath);
    }
    return normalizedPath;
  }

  public getRealPath(normalizedPath: string): string {
    return normalizeVaultPath(normalizedPath);
  }

  /**
   * Intercepts Obsidian's internal `reconcileInternalFile` so it reconciles against our
   * virtual Google Drive cache instead of checking the empty local stub folder.
   */
  public async reconcileInternalFile(normalizedPath: string): Promise<void> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      const anyBase = this.baseAdapter as DataAdapter & {
        reconcileInternalFile?: (p: string) => Promise<void>;
      };
      await anyBase.reconcileInternalFile?.(normalizedPath);
      return;
    }

    const clean = normalizeVaultPath(normalizedPath);
    if (!clean) return;

    const entry = this.cache.getEntry(clean);
    if (!entry) {
      this.onVaultEvent?.({ type: "file-removed", path: clean });
      return;
    }

    if (entry.type === "folder") {
      this.onVaultEvent?.({ type: "folder-created", path: clean });
    } else {
      this.onVaultEvent?.({
        type: "file-created",
        path: clean,
        stat: { ctime: entry.ctime, mtime: entry.mtime, size: entry.size },
      });
    }
  }

  public async watch(): Promise<void> {
    // Handled by Google Drive polling & virtual cache events
  }

  public async stopWatch(): Promise<void> {
    // No-op on virtual adapter
  }

  // ============================================================================
  // Initial Synchronization & Remote Delta Polling
  // ============================================================================

  /**
   * Initializes the virtual file tree from Google Drive and prefetches Markdown files
   * (and optionally small binary attachments) so Obsidian's MetadataCache and embeds work at native speed.
   */
  public async initializeFromDrive(
    rootFolderId: string,
    forceFullRefresh = false
  ): Promise<void> {
    this.onSyncStateChange?.("indexing", "Fetching file tree from Google Drive...");

    const remoteEntries = await this.driveClient.fetchFullVaultTree(rootFolderId);
    const remotePaths = new Set<string>();

    // Preserve any dirty local entries that haven't finished uploading yet
    const existingEntries = new Map(this.cache.getAllEntries().map((e) => [e.path, e]));
    const mergedEntries: VirtualEntry[] = [];

    for (const remote of remoteEntries) {
      remotePaths.add(remote.path);
      const local = existingEntries.get(remote.path);

      if (local?.dirty) {
        mergedEntries.push(local);
        continue;
      }

      const unchanged =
        !forceFullRefresh &&
        local &&
        local.contentCached &&
        ((remote.md5Checksum && local.md5Checksum === remote.md5Checksum) ||
          (!remote.md5Checksum && local.mtime === remote.mtime && local.size === remote.size));

      mergedEntries.push({
        ...remote,
        contentCached: Boolean(unchanged),
      });
    }

    // Keep any purely local dirty entries not yet on Drive
    for (const [path, local] of existingEntries.entries()) {
      if (!remotePaths.has(path)) {
        if (local.dirty) {
          mergedEntries.push(local);
        } else {
          await this.cache.deleteEntry(path);
          this.onVaultEvent?.({
            type: local.type === "folder" ? "folder-removed" : "file-removed",
            path,
          });
        }
      }
    }

    await this.cache.setEntriesBulk(mergedEntries);

    // Prefetch uncached text/markdown files (and small binaries if enabled) with bounded concurrency
    const settings = this.getSettings();
    const maxBinaryBytes = (settings.maxPrefetchBinarySizeMB || 25) * 1024 * 1024;

    const toPrefetch = mergedEntries.filter((entry) => {
      if (entry.type !== "file" || entry.contentCached || !entry.driveId) return false;
      if (this.shouldUseBaseAdapter(entry.path)) {
        return this.shouldSyncConfigPath(entry.path);
      }
      if (isTextFilePath(entry.path)) return true;
      if (settings.prefetchBinaries && entry.size > 0 && entry.size <= maxBinaryBytes) {
        return true;
      }
      return false;
    });

    if (toPrefetch.length > 0) {
      let completed = 0;
      const concurrency = 6;
      const queue = [...toPrefetch];

      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (!item || !item.driveId) break;
          try {
            await this.ensureFileContentCached(item, true);
          } catch (err) {
            console.warn(`[GoogleDriveDataAdapter] Failed to prefetch ${item.path}:`, err);
          } finally {
            completed++;
            this.onSyncStateChange?.(
              "indexing",
              `Caching vault files (${completed}/${toPrefetch.length})...`
            );
          }
        }
      });

      await Promise.all(workers);
    }

    if (settings.syncConfigDir) {
      await this.reconcileConfigDirWithDrive();
    }

    try {
      const startPageToken = await this.driveClient.getStartPageToken();
      await this.cache.setMeta("startPageToken", startPageToken);
    } catch (err) {
      console.warn("[GoogleDriveDataAdapter] Could not fetch startPageToken:", err);
    }

    this.onSyncStateChange?.("synced", "All files synced with Google Drive");
  }

  /**
   * Polls Google Drive `changes.list` for remote modifications, additions, renames, or deletions.
   */
  public async pollRemoteChanges(rootFolderId: string): Promise<number> {
    const startPageToken = this.cache.getMeta("startPageToken");
    if (!startPageToken) {
      const token = await this.driveClient.getStartPageToken();
      await this.cache.setMeta("startPageToken", token);
      return 0;
    }

    const { changes, newStartPageToken } = await this.driveClient.listChanges(startPageToken);
    await this.cache.setMeta("startPageToken", newStartPageToken);

    if (changes.length === 0) return 0;

    const driveIdMap = new Map<string, VirtualEntry>();
    for (const entry of this.cache.getAllEntries()) {
      if (entry.driveId) {
        driveIdMap.set(entry.driveId, entry);
      }
    }

    let appliedChanges = 0;

    for (const change of changes) {
      const existing = driveIdMap.get(change.fileId);

      // Case 1: File or folder was removed or trashed
      if (change.removed || change.file?.trashed) {
        if (existing && !existing.dirty) {
          if (this.shouldSyncConfigPath(existing.path)) {
            await this.removeFromBaseAdapterIfExists(existing.path, existing.type === "folder");
          }
          await this.removeEntryAndDescendantsFromCache(existing.path, true);
          appliedChanges++;
        }
        continue;
      }

      const file = change.file;
      if (!file) continue;

      const parentId = file.parents?.[0];
      let parentPath: string | null = null;
      if (parentId === rootFolderId) {
        parentPath = "";
      } else if (parentId) {
        const parentEntry = driveIdMap.get(parentId);
        if (parentEntry && parentEntry.type === "folder") {
          parentPath = parentEntry.path;
        }
      }

      // If parent is outside our vault root:
      if (parentPath === null) {
        if (existing && !existing.dirty) {
          if (this.shouldSyncConfigPath(existing.path)) {
            await this.removeFromBaseAdapterIfExists(existing.path, existing.type === "folder");
          }
          await this.removeEntryAndDescendantsFromCache(existing.path, true);
          appliedChanges++;
        }
        continue;
      }

      const newPath = normalizeVaultPath(parentPath ? `${parentPath}/${file.name}` : file.name);
      const isFolder = file.mimeType === DRIVE_FOLDER_MIME;
      const ctime = file.createdTime ? Date.parse(file.createdTime) : Date.now();
      const mtime = file.modifiedTime ? Date.parse(file.modifiedTime) : ctime;

      if (existing) {
        if (existing.dirty) continue;

        const wasRenamed = existing.path !== newPath;
        const contentChanged =
          !isFolder &&
          ((file.md5Checksum && file.md5Checksum !== existing.md5Checksum) ||
            (!file.md5Checksum && mtime > existing.mtime));

        if (!wasRenamed && !contentChanged) continue;

        const oldPath = existing.path;
        const updatedEntry: VirtualEntry = {
          ...existing,
          path: newPath,
          name: file.name,
          mtime,
          size: isFolder ? 0 : Number(file.size || 0),
          parentId,
          md5Checksum: file.md5Checksum,
          contentCached: !contentChanged && existing.contentCached,
        };

        if (wasRenamed) {
          await this.renameInCacheAndNotify(oldPath, newPath);
          if (this.shouldSyncConfigPath(oldPath) && this.shouldSyncConfigPath(newPath)) {
            await this.renameOnBaseAdapterIfExists(oldPath, newPath);
          }
        }

        await this.cache.setEntry(updatedEntry);
        driveIdMap.set(file.id, updatedEntry);

        if (!isFolder && contentChanged) {
          const buf = await this.ensureFileContentCached(updatedEntry, true);
          if (this.shouldSyncConfigPath(newPath)) {
            await this.writeConfigFileToBaseAdapter(
              newPath,
              buf,
              updatedEntry.mtime,
              updatedEntry.ctime
            );
          } else {
            this.onVaultEvent?.({
              type: "modified",
              path: newPath,
              stat: {
                ctime: updatedEntry.ctime,
                mtime: updatedEntry.mtime,
                size: updatedEntry.size,
              },
              remote: true,
            });
          }
        }

        appliedChanges++;
      } else {
        // Newly created remote file or folder
        await this.ensureLocalParentFoldersExist(newPath);

        const newEntry: VirtualEntry = {
          path: newPath,
          name: file.name,
          type: isFolder ? "folder" : "file",
          ctime,
          mtime,
          size: isFolder ? 0 : Number(file.size || 0),
          driveId: file.id,
          parentId,
          md5Checksum: file.md5Checksum,
          mimeType: file.mimeType,
          dirty: false,
          contentCached: false,
        };

        await this.cache.setEntry(newEntry);
        driveIdMap.set(file.id, newEntry);

        if (this.shouldSyncConfigPath(newPath)) {
          if (isFolder) {
            await this.ensureBaseAdapterFolderExists(newPath);
          } else {
            const buf = await this.ensureFileContentCached(newEntry, true);
            await this.writeConfigFileToBaseAdapter(newPath, buf, newEntry.mtime, newEntry.ctime);
          }
        } else if (!this.shouldUseBaseAdapter(newPath)) {
          if (!isFolder && isTextFilePath(newPath)) {
            await this.ensureFileContentCached(newEntry, true);
          }

          if (isFolder) {
            this.onVaultEvent?.({ type: "folder-created", path: newPath });
          } else {
            this.onVaultEvent?.({
              type: "file-created",
              path: newPath,
              stat: { ctime: newEntry.ctime, mtime: newEntry.mtime, size: newEntry.size },
            });
          }
        }
        appliedChanges++;
      }
    }

    return appliedChanges;
  }

  private async ensureFileContentCached(
    entry: VirtualEntry,
    forceDownload = false
  ): Promise<ArrayBuffer> {
    if (!forceDownload && entry.contentCached) {
      const cached = this.cache.getBinaryContent(entry.path);
      if (cached !== undefined) return cached;
    }

    if (!entry.driveId) {
      return new ArrayBuffer(0);
    }

    const existingPromise = this.inFlightDownloads.get(entry.path);
    if (existingPromise) {
      return existingPromise;
    }

    const downloadPromise = (async () => {
      let buffer = await this.driveClient.downloadBinary(entry.driveId!);
      if (isMarkdownFilePath(entry.path)) {
        const cleaned = driveMarkdownToObsidian(arrayBufferToString(buffer));
        buffer = stringToArrayBuffer(cleaned);
      }
      await this.cache.setBinaryContent(entry.path, buffer);
      return buffer;
    })().finally(() => {
      this.inFlightDownloads.delete(entry.path);
    });

    this.inFlightDownloads.set(entry.path, downloadPromise);
    return downloadPromise;
  }

  // ============================================================================
  // Standard Obsidian DataAdapter Implementation
  // ============================================================================

  public async exists(normalizedPath: string, sensitive?: boolean): Promise<boolean> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      return this.baseAdapter.exists(normalizedPath, sensitive);
    }

    const clean = normalizeVaultPath(normalizedPath);
    if (clean === "") return true;

    if (this.cache.getEntry(clean)) {
      return true;
    }

    if (sensitive === false) {
      const lower = clean.toLowerCase();
      return this.cache.getAllEntries().some((e) => e.path.toLowerCase() === lower);
    }

    return false;
  }

  public async stat(normalizedPath: string): Promise<Stat | null> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      return this.baseAdapter.stat(normalizedPath);
    }

    const clean = normalizeVaultPath(normalizedPath);
    if (clean === "") {
      const now = Date.now();
      return { type: "folder", ctime: now, mtime: now, size: 0 };
    }

    const entry = this.cache.getEntry(clean);
    if (!entry) return null;

    return {
      type: entry.type,
      ctime: entry.ctime,
      mtime: entry.mtime,
      size: entry.size,
    };
  }

  public async list(normalizedPath: string): Promise<ListedFiles> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      return this.baseAdapter.list(normalizedPath);
    }

    const clean = normalizeVaultPath(normalizedPath);
    const files: string[] = [];
    const folders: string[] = [];

    for (const entry of this.cache.getAllEntries()) {
      if (this.shouldUseBaseAdapter(entry.path)) continue;
      if (getParentPath(entry.path) === clean) {
        if (entry.type === "folder") {
          folders.push(entry.path);
        } else {
          files.push(entry.path);
        }
      }
    }

    files.sort((a, b) => a.localeCompare(b));
    folders.sort((a, b) => a.localeCompare(b));

    return { files, folders };
  }

  public async read(normalizedPath: string): Promise<string> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      return this.baseAdapter.read(normalizedPath);
    }

    const clean = normalizeVaultPath(normalizedPath);
    const entry = this.cache.getEntry(clean);
    if (!entry || entry.type !== "file") {
      throw new Error(`ENOENT: no such file, open '${normalizedPath}'`);
    }

    const cachedText = this.cache.getTextContent(clean);
    if (cachedText !== undefined) {
      if (isMarkdownFilePath(clean)) {
        const cleaned = driveMarkdownToObsidian(cachedText);
        if (cleaned !== cachedText) {
          await this.cache.setTextContent(clean, cleaned);
        }
        return cleaned;
      }
      return cachedText;
    }

    const buffer = await this.ensureFileContentCached(entry);
    const text = arrayBufferToString(buffer);
    return isMarkdownFilePath(clean) ? driveMarkdownToObsidian(text) : text;
  }

  public async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      return this.baseAdapter.readBinary(normalizedPath);
    }

    const clean = normalizeVaultPath(normalizedPath);
    const entry = this.cache.getEntry(clean);
    if (!entry || entry.type !== "file") {
      throw new Error(`ENOENT: no such file, open '${normalizedPath}'`);
    }

    const cachedBin = this.cache.getBinaryContent(clean);
    if (cachedBin !== undefined) {
      return cachedBin;
    }

    return this.ensureFileContentCached(entry);
  }

  public async write(
    normalizedPath: string,
    data: string,
    options?: DataWriteOptions
  ): Promise<void> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      await this.baseAdapter.write(normalizedPath, data, options);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        await this.mirrorLocalConfigWriteToDrive(
          normalizedPath,
          stringToArrayBuffer(data),
          options
        );
      }
      return;
    }

    const buffer = stringToArrayBuffer(data);
    await this.writeBinary(normalizedPath, buffer, options);
  }

  public async writeBinary(
    normalizedPath: string,
    data: ArrayBuffer,
    options?: DataWriteOptions
  ): Promise<void> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      await this.baseAdapter.writeBinary(normalizedPath, data, options);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        await this.mirrorLocalConfigWriteToDrive(normalizedPath, data, options);
      }
      return;
    }

    const clean = normalizeVaultPath(normalizedPath);
    if (isMarkdownFilePath(clean)) {
      const cleanedMd = driveMarkdownToObsidian(arrayBufferToString(data));
      data = stringToArrayBuffer(cleanedMd);
    }
    await this.ensureLocalParentFoldersExist(clean);

    const now = Date.now();
    const existing = this.cache.getEntry(clean);
    const isNewFile = !existing;

    const entry: VirtualEntry = {
      path: clean,
      name: getBaseName(clean),
      type: "file",
      ctime: options?.ctime ?? existing?.ctime ?? now,
      mtime: options?.mtime ?? now,
      size: data.byteLength,
      driveId: existing?.driveId,
      parentId: existing?.parentId,
      md5Checksum: existing?.md5Checksum,
      mimeType: existing?.mimeType || guessMimeType(clean),
      dirty: true,
      contentCached: true,
    };

    await this.cache.setEntry(entry);
    await this.cache.setBinaryContent(clean, data);

    // Invoke Obsidian's internal `options.immediate` callback if provided by `Vault.modify`
    if (typeof options?.immediate === "function") {
      options.immediate();
    }

    // Crucial: Notify Obsidian's Vault BEFORE write() resolves so Vault.create() finds the new TFile in fileMap!
    const stat = { ctime: entry.ctime, mtime: entry.mtime, size: entry.size };
    if (isNewFile) {
      this.onVaultEvent?.({ type: "file-created", path: clean, stat });
    } else {
      this.onVaultEvent?.({ type: "modified", path: clean, stat });
    }

    this.scheduleDebouncedUpload(clean);
  }

  public async append(
    normalizedPath: string,
    data: string,
    options?: DataWriteOptions
  ): Promise<void> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      await this.baseAdapter.append(normalizedPath, data, options);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        const updatedBuf = await this.baseAdapter.readBinary(normalizedPath);
        await this.mirrorLocalConfigWriteToDrive(normalizedPath, updatedBuf, options);
      }
      return;
    }

    const clean = normalizeVaultPath(normalizedPath);
    const exists = await this.exists(clean);
    const current = exists ? await this.read(clean) : "";
    await this.write(clean, current + data, options);
  }

  public async appendBinary(
    normalizedPath: string,
    data: ArrayBuffer,
    options?: DataWriteOptions
  ): Promise<void> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      await this.baseAdapter.appendBinary(normalizedPath, data, options);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        const updatedBuf = await this.baseAdapter.readBinary(normalizedPath);
        await this.mirrorLocalConfigWriteToDrive(normalizedPath, updatedBuf, options);
      }
      return;
    }

    const clean = normalizeVaultPath(normalizedPath);
    const exists = await this.exists(clean);
    const current = exists ? await this.readBinary(clean) : new ArrayBuffer(0);
    await this.writeBinary(clean, concatArrayBuffers(current, data), options);
  }

  public async process(
    normalizedPath: string,
    fn: (data: string) => string,
    options?: DataWriteOptions
  ): Promise<string> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      const updated = await this.baseAdapter.process(normalizedPath, fn, options);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        await this.mirrorLocalConfigWriteToDrive(
          normalizedPath,
          stringToArrayBuffer(updated),
          options
        );
      }
      return updated;
    }

    const current = await this.read(normalizedPath);
    const updated = fn(current);
    await this.write(normalizedPath, updated, options);
    return updated;
  }

  public getResourcePath(normalizedPath: string): string {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      return this.baseAdapter.getResourcePath(normalizedPath);
    }

    const clean = normalizeVaultPath(normalizedPath);
    const blobUrl = this.cache.getBlobUrl(clean);
    if (blobUrl) {
      // Append an empty fragment so plugins that cache-bust with `${src}?t=${mtime}` (e.g. Ink)
      // put the query inside the fragment. Blob URLs with a query string fail to resolve,
      // but fragments are ignored during blob URL resolution.
      return `${blobUrl}#`;
    }

    const entry = this.cache.getEntry(clean);
    if (entry && entry.type === "file" && entry.driveId) {
      // Content isn't cached yet: download it, then fire a "modified" event so embeds
      // re-request the resource path and pick up the new blob URL.
      void this.ensureFileContentCached(entry)
        .then(() => {
          const latest = this.cache.getEntry(clean);
          if (!latest) return;
          this.onVaultEvent?.({
            type: "modified",
            path: clean,
            stat: { ctime: latest.ctime, mtime: latest.mtime, size: latest.size },
          });
        })
        .catch((err) => {
          console.warn(`[GoogleDriveDataAdapter] Failed to fetch resource ${clean}:`, err);
        });
    }

    return this.baseAdapter.getResourcePath(normalizedPath);
  }

  public async mkdir(normalizedPath: string): Promise<void> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      await this.baseAdapter.mkdir(normalizedPath);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        const cleanConfigFolder = normalizeVaultPath(normalizedPath);
        await this.ensureLocalFolderChain(cleanConfigFolder);
        if (this.isDriveReady()) {
          void this.ensureDriveFolderChain(cleanConfigFolder).catch((err) => {
            console.warn(
              `[GoogleDriveDataAdapter] Background mkdir failed for ${cleanConfigFolder}:`,
              err
            );
          });
        }
      }
      return;
    }

    const clean = normalizeVaultPath(normalizedPath);
    if (!clean) return;

    await this.ensureLocalFolderChain(clean);

    if (this.isDriveReady()) {
      void this.ensureDriveFolderChain(clean).catch((err) => {
        console.warn(`[GoogleDriveDataAdapter] Background mkdir failed for ${clean}:`, err);
      });
    }
  }

  public async trashSystem(normalizedPath: string): Promise<boolean> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      const res = await this.baseAdapter.trashSystem(normalizedPath);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        await this.removeSyncedConfigFromDrive(normalizedPath, true);
      }
      return res;
    }

    await this.remove(normalizedPath, true);
    return true;
  }

  public async trashLocal(normalizedPath: string): Promise<void> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      await this.baseAdapter.trashLocal(normalizedPath);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        await this.removeSyncedConfigFromDrive(normalizedPath, true);
      }
      return;
    }

    const clean = normalizeVaultPath(normalizedPath);
    const trashFolder = ".trash";
    await this.mkdir(trashFolder);
    const baseName = getBaseName(clean);
    let destPath = `${trashFolder}/${baseName}`;
    let counter = 1;
    while (await this.exists(destPath)) {
      counter++;
      const dotIdx = baseName.lastIndexOf(".");
      if (dotIdx > 0) {
        destPath = `${trashFolder}/${baseName.slice(0, dotIdx)} ${counter}${baseName.slice(dotIdx)}`;
      } else {
        destPath = `${trashFolder}/${baseName} ${counter}`;
      }
    }
    await this.rename(clean, destPath);
  }

  public async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      await this.baseAdapter.rmdir(normalizedPath, recursive);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        await this.removeSyncedConfigFromDrive(normalizedPath, true);
      }
      return;
    }

    const clean = normalizeVaultPath(normalizedPath);
    const entry = this.cache.getEntry(clean);
    if (!entry) return;

    const children = this.cache
      .getAllEntries()
      .filter((e) => e.path.startsWith(`${clean}/`));

    if (!recursive && children.length > 0) {
      throw new Error(`ENOTEMPTY: directory not empty, rmdir '${normalizedPath}'`);
    }

    await this.remove(clean, true);
  }

  public async remove(normalizedPath: string, useTrash = true): Promise<void> {
    if (this.shouldUseBaseAdapter(normalizedPath)) {
      await this.baseAdapter.remove(normalizedPath);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        await this.removeSyncedConfigFromDrive(normalizedPath, useTrash);
      }
      return;
    }

    const clean = normalizeVaultPath(normalizedPath);
    const entry = this.cache.getEntry(clean);
    if (!entry) return;

    await this.removeEntryAndDescendantsFromCache(clean, true);

    if (entry.driveId && this.isDriveReady()) {
      this.incrementActiveUploads();
      try {
        if (useTrash) {
          await this.driveClient.trashFile(entry.driveId);
        } else {
          await this.driveClient.deleteFile(entry.driveId);
        }
      } catch (err) {
        console.error(`[GoogleDriveDataAdapter] Failed to delete ${clean} on Drive:`, err);
      } finally {
        this.decrementActiveUploads();
      }
    }
  }

  public async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    if (
      this.shouldUseBaseAdapter(normalizedPath) ||
      this.shouldUseBaseAdapter(normalizedNewPath)
    ) {
      await this.baseAdapter.rename(normalizedPath, normalizedNewPath);
      if (this.shouldSyncConfigPath(normalizedPath)) {
        await this.removeSyncedConfigFromDrive(normalizedPath, true);
      }
      if (this.shouldSyncConfigPath(normalizedNewPath)) {
        const stat = await this.baseAdapter.stat(normalizedNewPath);
        if (stat?.type === "file") {
          const buf = await this.baseAdapter.readBinary(normalizedNewPath);
          await this.mirrorLocalConfigWriteToDrive(normalizedNewPath, buf, {
            ctime: stat.ctime,
            mtime: stat.mtime,
          });
        }
      }
      return;
    }

    const oldClean = normalizeVaultPath(normalizedPath);
    const newClean = normalizeVaultPath(normalizedNewPath);
    if (oldClean === newClean) return;

    const entry = this.cache.getEntry(oldClean);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, rename '${normalizedPath}'`);
    }

    await this.ensureLocalParentFoldersExist(newClean);
    await this.renameInCacheAndNotify(oldClean, newClean);

    const existingRenameTimer = this.writeTimers.get(oldClean);
    if (existingRenameTimer) {
      window.clearTimeout(existingRenameTimer);
      this.writeTimers.delete(oldClean);
      this.scheduleDebouncedUpload(newClean);
      return;
    }

    const updatedEntry = this.cache.getEntry(newClean);
    if (updatedEntry?.driveId && this.isDriveReady()) {
      this.incrementActiveUploads();
      try {
        const newParentPath = getParentPath(newClean);
        const newParentId = await this.ensureDriveFolderChain(newParentPath);
        const meta = await this.driveClient.moveOrRename(
          updatedEntry.driveId,
          getBaseName(newClean),
          updatedEntry.parentId,
          newParentId
        );
        updatedEntry.parentId = newParentId;
        updatedEntry.mtime = meta.modifiedTime ? Date.parse(meta.modifiedTime) : Date.now();
        await this.cache.setEntry(updatedEntry);
      } catch (err) {
        console.error(
          `[GoogleDriveDataAdapter] Failed to rename ${oldClean} -> ${newClean} on Drive:`,
          err
        );
      } finally {
        this.decrementActiveUploads();
      }
    }
  }

  public async copy(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    if (
      this.shouldUseBaseAdapter(normalizedPath) ||
      this.shouldUseBaseAdapter(normalizedNewPath)
    ) {
      await this.baseAdapter.copy(normalizedPath, normalizedNewPath);
      if (this.shouldSyncConfigPath(normalizedNewPath)) {
        const buf = await this.baseAdapter.readBinary(normalizedNewPath);
        await this.mirrorLocalConfigWriteToDrive(normalizedNewPath, buf);
      }
      return;
    }

    const srcClean = normalizeVaultPath(normalizedPath);
    const destClean = normalizeVaultPath(normalizedNewPath);

    if (await this.exists(destClean)) {
      throw new Error(
        `EEXIST: file already exists, copyfile '${normalizedPath}' -> '${normalizedNewPath}'`
      );
    }

    const data = await this.readBinary(srcClean);
    await this.writeBinary(destClean, data);
  }

  // ============================================================================
  // Internal Tree Helpers & Debounced Upload Engine
  // ============================================================================

  private isDriveReady(): boolean {
    const s = this.getSettings();
    return Boolean(s.rootFolderId && (s.refreshToken || s.accessToken));
  }

  private async ensureLocalParentFoldersExist(filePath: string): Promise<void> {
    const parentPath = getParentPath(filePath);
    if (parentPath) {
      await this.ensureLocalFolderChain(parentPath);
    }
  }

  private async ensureLocalFolderChain(folderPath: string): Promise<void> {
    const clean = normalizeVaultPath(folderPath);
    if (!clean) return;

    const parts = clean.split("/");
    let current = "";
    const now = Date.now();

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.cache.getEntry(current)) {
        await this.cache.setEntry({
          path: current,
          name: part,
          type: "folder",
          ctime: now,
          mtime: now,
          size: 0,
          dirty: true,
        });
        this.onVaultEvent?.({ type: "folder-created", path: current });
      }
    }
  }

  private async ensureDriveFolderChain(folderPath: string): Promise<string> {
    const clean = normalizeVaultPath(folderPath);
    const rootFolderId = this.getSettings().rootFolderId;
    if (!clean) return rootFolderId;

    const existing = this.cache.getEntry(clean);
    if (existing?.driveId) return existing.driveId;

    const inFlight = this.folderCreationLocks.get(clean);
    if (inFlight) return inFlight;

    const creationPromise = (async () => {
      const parentPath = getParentPath(clean);
      const parentDriveId = await this.ensureDriveFolderChain(parentPath);

      const recheck = this.cache.getEntry(clean);
      if (recheck?.driveId) return recheck.driveId;

      const folderName = getBaseName(clean);
      const created = await this.driveClient.createFolder(folderName, parentDriveId);

      const now = Date.now();
      const folderEntry: VirtualEntry = {
        path: clean,
        name: folderName,
        type: "folder",
        ctime: created.createdTime ? Date.parse(created.createdTime) : now,
        mtime: created.modifiedTime ? Date.parse(created.modifiedTime) : now,
        size: 0,
        driveId: created.id,
        parentId: parentDriveId,
        mimeType: DRIVE_FOLDER_MIME,
        dirty: false,
      };
      await this.cache.setEntry(folderEntry);
      return created.id;
    })().finally(() => {
      this.folderCreationLocks.delete(clean);
    });

    this.folderCreationLocks.set(clean, creationPromise);
    return creationPromise;
  }

  private scheduleDebouncedUpload(normalizedPath: string): void {
    const existingTimer = this.writeTimers.get(normalizedPath);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    const delay = Math.max(250, this.getSettings().writeDebounceMs || 2500);
    this.onSyncStateChange?.("syncing", `Queued changes for ${getBaseName(normalizedPath)}...`);

    const timer = window.setTimeout(() => {
      this.writeTimers.delete(normalizedPath);
      void this.flushFileUpload(normalizedPath);
    }, delay);

    this.writeTimers.set(normalizedPath, timer);
  }

  public async flushAllPendingUploads(): Promise<void> {
    const pendingPaths = Array.from(this.writeTimers.keys());
    for (const path of pendingPaths) {
      const timer = this.writeTimers.get(path);
      if (timer) window.clearTimeout(timer);
      this.writeTimers.delete(path);
    }

    const dirtyFiles = this.cache
      .getAllEntries()
      .filter((e) => e.type === "file" && e.dirty)
      .map((e) => e.path);

    const uniquePaths = Array.from(new Set([...pendingPaths, ...dirtyFiles]));
    for (const path of uniquePaths) {
      await this.flushFileUpload(path);
    }
  }

  private async flushFileUpload(normalizedPath: string): Promise<void> {
    if (!this.isDriveReady()) return;

    const entry = this.cache.getEntry(normalizedPath);
    if (!entry || entry.type !== "file" || !entry.dirty) return;

    const data = this.cache.getBinaryContent(normalizedPath);
    if (!data) return;

    this.incrementActiveUploads();
    try {
      const parentPath = getParentPath(normalizedPath);
      const parentDriveId = await this.ensureDriveFolderChain(parentPath);

      const uploadPayload: ArrayBuffer | string = isMarkdownFilePath(normalizedPath)
        ? obsidianMarkdownToDrive(arrayBufferToString(data))
        : data;

      const uploaded = await this.driveClient.uploadFile({
        fileId: entry.driveId,
        name: entry.name,
        parentId: parentDriveId,
        data: uploadPayload,
        mimeType: entry.mimeType || guessMimeType(normalizedPath),
        mtime: entry.mtime,
      });

      const latestEntry = this.cache.getEntry(normalizedPath);
      if (latestEntry) {
        latestEntry.driveId = uploaded.id;
        latestEntry.parentId = parentDriveId;
        latestEntry.md5Checksum = uploaded.md5Checksum;
        if (latestEntry.mtime <= entry.mtime) {
          latestEntry.dirty = false;
          if (uploaded.modifiedTime) {
            latestEntry.mtime = Date.parse(uploaded.modifiedTime);
          }
        }
        await this.cache.setEntry(latestEntry);
      }
    } catch (err) {
      console.error(`[GoogleDriveDataAdapter] Failed to upload ${normalizedPath}:`, err);
      this.onSyncStateChange?.("error", `Upload failed for ${entry.name}`);
    } finally {
      this.decrementActiveUploads();
    }
  }

  private async removeEntryAndDescendantsFromCache(
    normalizedPath: string,
    notifyVault: boolean
  ): Promise<void> {
    const clean = normalizeVaultPath(normalizedPath);
    const toRemove = this.cache
      .getAllEntries()
      .filter((e) => e.path === clean || e.path.startsWith(`${clean}/`));

    // Remove children first, then parent
    toRemove.sort((a, b) => b.path.length - a.path.length);

    for (const item of toRemove) {
      const timer = this.writeTimers.get(item.path);
      if (timer) {
        window.clearTimeout(timer);
        this.writeTimers.delete(item.path);
      }
      await this.cache.deleteEntry(item.path);
      if (notifyVault) {
        this.onVaultEvent?.({
          type: item.type === "folder" ? "folder-removed" : "file-removed",
          path: item.path,
        });
      }
    }
  }

  private async renameInCacheAndNotify(oldClean: string, newClean: string): Promise<void> {
    const affected = this.cache
      .getAllEntries()
      .filter((e) => e.path === oldClean || e.path.startsWith(`${oldClean}/`));

    // Sort shortest path first so parent folder is renamed before children
    affected.sort((a, b) => a.path.length - b.path.length);

    for (const item of affected) {
      const oldItemPath = item.path;
      const suffix = oldItemPath.slice(oldClean.length);
      const targetPath = normalizeVaultPath(`${newClean}${suffix}`);
      const content = this.cache.getBinaryContent(oldItemPath);

      await this.cache.deleteEntry(oldItemPath);

      const updated: VirtualEntry = {
        ...item,
        path: targetPath,
        name: getBaseName(targetPath),
      };
      await this.cache.setEntry(updated);
      if (content !== undefined) {
        await this.cache.setBinaryContent(targetPath, content);
      }

      this.onVaultEvent?.({
        type: "renamed",
        newPath: targetPath,
        oldPath: oldItemPath,
      });
    }
  }

  private incrementActiveUploads(): void {
    this.activeUploads++;
    this.onSyncStateChange?.("syncing", `Syncing (${this.activeUploads} active)...`);
  }

  private decrementActiveUploads(): void {
    this.activeUploads = Math.max(0, this.activeUploads - 1);
    if (this.activeUploads === 0 && this.writeTimers.size === 0) {
      this.onSyncStateChange?.("synced", "All changes saved to Google Drive");
    }
  }

  // ============================================================================
  // `.obsidian` Configuration & Plugin Directory Two-Way Sync
  // ============================================================================

  /**
   * Reconciles the local `.obsidian` directory (`baseAdapter`) with the remote `.obsidian`
   * directory on Google Drive (`this.cache`) when `syncConfigDir` is enabled.
   */
  public async reconcileConfigDirWithDrive(): Promise<{ pulled: number; pushed: number }> {
    if (!this.getSettings().syncConfigDir || !this.isDriveReady()) {
      return { pulled: 0, pushed: 0 };
    }

    let pulled = 0;
    let pushed = 0;

    const localScan = await this.scanLocalConfigDir(this.configDir);
    const remoteConfigEntries = this.cache
      .getAllEntries()
      .filter((e) => this.shouldSyncConfigPath(e.path));
    const remoteMap = new Map(remoteConfigEntries.map((e) => [e.path, e]));

    // 1. Ensure remote folders exist locally
    const remoteFolders = remoteConfigEntries
      .filter((e) => e.type === "folder")
      .sort((a, b) => a.path.length - b.path.length);
    for (const folder of remoteFolders) {
      if (!localScan.folders.has(folder.path)) {
        await this.ensureBaseAdapterFolderExists(folder.path);
      }
    }

    // 2. Reconcile remote config files against local `.obsidian` files
    for (const remoteEntry of remoteConfigEntries) {
      if (remoteEntry.type !== "file" || !remoteEntry.driveId) continue;

      const localStat = localScan.files.get(remoteEntry.path);
      const remoteBuf = await this.ensureFileContentCached(remoteEntry);

      if (!localStat) {
        await this.writeConfigFileToBaseAdapter(
          remoteEntry.path,
          remoteBuf,
          remoteEntry.mtime,
          remoteEntry.ctime
        );
        pulled++;
      } else {
        const localBuf = await this.baseAdapter.readBinary(remoteEntry.path);
        if (arrayBuffersEqual(localBuf, remoteBuf)) {
          continue;
        }
        if (remoteEntry.mtime > localStat.mtime) {
          await this.writeConfigFileToBaseAdapter(
            remoteEntry.path,
            remoteBuf,
            remoteEntry.mtime,
            remoteEntry.ctime
          );
          pulled++;
        } else {
          await this.mirrorLocalConfigWriteToDrive(remoteEntry.path, localBuf, {
            ctime: localStat.ctime,
            mtime: localStat.mtime,
          });
          pushed++;
        }
      }
    }

    // 3. Push any local `.obsidian` files that don't exist on Google Drive yet
    for (const [localPath, localStat] of localScan.files.entries()) {
      if (!remoteMap.has(localPath)) {
        const localBuf = await this.baseAdapter.readBinary(localPath);
        await this.mirrorLocalConfigWriteToDrive(localPath, localBuf, {
          ctime: localStat.ctime,
          mtime: localStat.mtime,
        });
        pushed++;
      }
    }

    if (pushed > 0) {
      await this.flushAllPendingUploads();
    }

    return { pulled, pushed };
  }

  private async scanLocalConfigDir(
    rootConfigDir: string
  ): Promise<{ files: Map<string, Stat>; folders: Set<string> }> {
    const files = new Map<string, Stat>();
    const folders = new Set<string>();
    const cleanRoot = normalizeVaultPath(rootConfigDir);

    if (!(await this.baseAdapter.exists(cleanRoot))) {
      return { files, folders };
    }

    const queue: string[] = [cleanRoot];
    while (queue.length > 0) {
      const currentDir = queue.shift()!;
      if (!this.shouldSyncConfigPath(currentDir)) continue;
      folders.add(currentDir);

      let listed: ListedFiles;
      try {
        listed = await this.baseAdapter.list(currentDir);
      } catch {
        continue;
      }

      for (const subFolder of listed.folders) {
        const cleanSub = normalizeVaultPath(subFolder);
        if (this.shouldSyncConfigPath(cleanSub)) {
          queue.push(cleanSub);
        }
      }

      for (const filePath of listed.files) {
        const cleanFile = normalizeVaultPath(filePath);
        if (!this.shouldSyncConfigPath(cleanFile)) continue;
        try {
          const st = await this.baseAdapter.stat(cleanFile);
          if (st && st.type === "file") {
            files.set(cleanFile, st);
          }
        } catch {
          // Ignore transient stat error
        }
      }
    }

    return { files, folders };
  }

  private async mirrorLocalConfigWriteToDrive(
    normalizedPath: string,
    data: ArrayBuffer,
    options?: DataWriteOptions
  ): Promise<void> {
    const clean = normalizeVaultPath(normalizedPath);
    if (!this.shouldSyncConfigPath(clean)) return;

    const existing = this.cache.getEntry(clean);
    const existingBuf = this.cache.getBinaryContent(clean);
    if (existing && !existing.dirty && existingBuf && arrayBuffersEqual(existingBuf, data)) {
      return;
    }

    await this.ensureLocalParentFoldersExist(clean);
    const now = Date.now();

    const entry: VirtualEntry = {
      path: clean,
      name: getBaseName(clean),
      type: "file",
      ctime: options?.ctime ?? existing?.ctime ?? now,
      mtime: options?.mtime ?? now,
      size: data.byteLength,
      driveId: existing?.driveId,
      parentId: existing?.parentId,
      md5Checksum: existing?.md5Checksum,
      mimeType: existing?.mimeType || guessMimeType(clean),
      dirty: true,
      contentCached: true,
    };

    await this.cache.setEntry(entry);
    await this.cache.setBinaryContent(clean, data);
    this.scheduleDebouncedUpload(clean);
  }

  private async removeSyncedConfigFromDrive(
    normalizedPath: string,
    useTrash = true
  ): Promise<void> {
    const clean = normalizeVaultPath(normalizedPath);
    const entry = this.cache.getEntry(clean);
    if (!entry) return;

    await this.removeEntryAndDescendantsFromCache(clean, false);

    if (entry.driveId && this.isDriveReady()) {
      this.incrementActiveUploads();
      try {
        if (useTrash) {
          await this.driveClient.trashFile(entry.driveId);
        } else {
          await this.driveClient.deleteFile(entry.driveId);
        }
      } catch (err) {
        console.error(`[GoogleDriveDataAdapter] Failed to delete config ${clean} on Drive:`, err);
      } finally {
        this.decrementActiveUploads();
      }
    }
  }

  private async ensureBaseAdapterFolderExists(folderPath: string): Promise<void> {
    const clean = normalizeVaultPath(folderPath);
    if (!clean) return;

    const parts = clean.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      try {
        if (!(await this.baseAdapter.exists(current))) {
          await this.baseAdapter.mkdir(current);
        }
      } catch {
        // Ignore if directory already exists
      }
    }
  }

  private async writeConfigFileToBaseAdapter(
    filePath: string,
    data: ArrayBuffer,
    mtime?: number,
    ctime?: number
  ): Promise<void> {
    const clean = normalizeVaultPath(filePath);
    const parent = getParentPath(clean);
    if (parent) {
      await this.ensureBaseAdapterFolderExists(parent);
    }

    try {
      if (await this.baseAdapter.exists(clean)) {
        const currentBuf = await this.baseAdapter.readBinary(clean);
        if (arrayBuffersEqual(currentBuf, data)) {
          return;
        }
      }
    } catch {
      // Proceed to write
    }

    await this.baseAdapter.writeBinary(clean, data, { mtime, ctime });
  }

  private async removeFromBaseAdapterIfExists(
    targetPath: string,
    isFolder: boolean
  ): Promise<void> {
    const clean = normalizeVaultPath(targetPath);
    try {
      if (await this.baseAdapter.exists(clean)) {
        if (isFolder) {
          await this.baseAdapter.rmdir(clean, true);
        } else {
          await this.baseAdapter.remove(clean);
        }
      }
    } catch {
      // Ignore if already removed locally
    }
  }

  private async renameOnBaseAdapterIfExists(oldPath: string, newPath: string): Promise<void> {
    const oldClean = normalizeVaultPath(oldPath);
    const newClean = normalizeVaultPath(newPath);
    try {
      if (await this.baseAdapter.exists(oldClean)) {
        const parent = getParentPath(newClean);
        if (parent) {
          await this.ensureBaseAdapterFolderExists(parent);
        }
        await this.baseAdapter.rename(oldClean, newClean);
      }
    } catch {
      // Ignore if rename fails locally
    }
  }
}
