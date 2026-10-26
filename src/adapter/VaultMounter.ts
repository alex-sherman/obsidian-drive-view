import { App, DataAdapter, MarkdownView, TFile, TFolder } from "obsidian";
import { getParentPath, isConfigOrInternalPath } from "../utils/pathUtils";
import {
  GoogleDriveDataAdapter,
  ObsidianVaultRawEvent,
} from "./GoogleDriveDataAdapter";

type InternalVault = App["vault"] & {
  fileMap?: Record<string, TFile | TFolder>;
  onChange?: (
    type:
      | "folder-created"
      | "file-created"
      | "modified"
      | "file-removed"
      | "folder-removed"
      | "renamed"
      | "raw"
      | "closed",
    path: string,
    oldPathOrRealPath?: string,
    stat?: { ctime: number; mtime: number; size: number }
  ) => void;
};

type InternalMetadataCache = App["metadataCache"] & {
  initialize?: () => void;
};

export class VaultMounter {
  private mounted = false;
  private originalAdapter: DataAdapter | null = null;

  constructor(private readonly app: App) {}

  public isMounted(): boolean {
    return this.mounted;
  }

  public getOriginalAdapter(): DataAdapter {
    return this.originalAdapter || this.app.vault.adapter;
  }

  /**
   * Swaps `app.vault.adapter` with the proxied `GoogleDriveDataAdapter` and reconciles
   * Obsidian's Vault fileMap and MetadataCache with the virtual file tree.
   */
  public async mount(driveAdapter: GoogleDriveDataAdapter): Promise<void> {
    if (!this.originalAdapter) {
      this.originalAdapter = this.app.vault.adapter;
    }

    // Stop local filesystem watcher on the stub folder while virtual adapter is active
    const anyOriginal = this.originalAdapter as DataAdapter & {
      stopWatch?: () => Promise<void> | void;
    };
    try {
      await anyOriginal.stopWatch?.();
    } catch {
      // Ignore if stopWatch is not supported on this platform
    }

    this.app.vault.adapter = driveAdapter.createProxiedAdapter();
    this.mounted = true;

    await this.reconcileFullVault(driveAdapter);
  }

  /**
   * Flushes pending writes and restores the original native `DataAdapter`.
   */
  public async unmount(driveAdapter?: GoogleDriveDataAdapter): Promise<void> {
    if (!this.mounted || !this.originalAdapter) return;

    try {
      await driveAdapter?.flushAllPendingUploads();
    } catch (err) {
      console.warn("[VaultMounter] Error flushing pending uploads on unmount:", err);
    }

    this.app.vault.adapter = this.originalAdapter;
    this.mounted = false;
  }

  /**
   * Synchronously applies a low-level adapter event (`file-created`, `folder-created`, `modified`,
   * `file-removed`, `folder-removed`, `renamed`) to Obsidian's internal `Vault.onChange`.
   *
   * Note: Must run synchronously when called from `adapter.write()` / `adapter.mkdir()` so that
   * `Vault.create()` immediately finds the newly created `TFile` in `vault.fileMap`!
   */
  public applyVaultRawEvent(evt: ObsidianVaultRawEvent): void {
    const internalVault = this.app.vault as InternalVault;
    if (typeof internalVault.onChange !== "function") return;

    if (evt.type === "folder-created") {
      this.ensureParentFoldersInVault(evt.path, internalVault);
      if (!this.app.vault.getAbstractFileByPath(evt.path)) {
        internalVault.onChange("folder-created", evt.path);
      }
      return;
    }

    if (evt.type === "file-created") {
      this.ensureParentFoldersInVault(evt.path, internalVault);
      internalVault.onChange("raw", evt.path, evt.path, evt.stat);
      if (!this.app.vault.getAbstractFileByPath(evt.path)) {
        internalVault.onChange("file-created", evt.path, evt.path, evt.stat);
      } else {
        void this.syncOpenViewsAndNotifyModified(evt.path, evt.stat, internalVault);
      }
      return;
    }

    if (evt.type === "modified") {
      internalVault.onChange("raw", evt.path, evt.path, evt.stat);
      if (this.app.vault.getAbstractFileByPath(evt.path)) {
        if (evt.remote) {
          void this.syncOpenViewsAndNotifyModified(evt.path, evt.stat, internalVault);
        } else {
          internalVault.onChange("modified", evt.path, evt.path, evt.stat);
        }
      } else {
        this.ensureParentFoldersInVault(evt.path, internalVault);
        internalVault.onChange("file-created", evt.path, evt.path, evt.stat);
      }
      return;
    }

    if (evt.type === "file-removed" || evt.type === "folder-removed") {
      if (this.app.vault.getAbstractFileByPath(evt.path)) {
        internalVault.onChange(evt.type, evt.path);
      }
      return;
    }

    if (evt.type === "renamed") {
      this.ensureParentFoldersInVault(evt.newPath, internalVault);
      if (this.app.vault.getAbstractFileByPath(evt.oldPath)) {
        internalVault.onChange("renamed", evt.newPath, evt.oldPath);
      }
      return;
    }
  }

  private ensureParentFoldersInVault(path: string, internalVault: InternalVault): void {
    const parentPath = getParentPath(path);
    if (!parentPath) return;

    const parts = parentPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        internalVault.onChange?.("folder-created", current);
      }
    }
  }

  /**
   * Reconciles Obsidian's `Vault.fileMap` with all entries in `driveAdapter.cache`.
   */
  public async reconcileFullVault(driveAdapter: GoogleDriveDataAdapter): Promise<void> {
    const internalVault = this.app.vault as InternalVault;
    const configDir = this.app.vault.configDir || ".obsidian";

    const entries = driveAdapter.cache.getAllEntries();
    const virtualPaths = new Set(entries.map((e) => e.path));

    // 1. Remove any stale non-config files from Vault.fileMap that don't exist in virtual cache
    if (internalVault.fileMap) {
      const existingPaths = Object.keys(internalVault.fileMap).filter(
        (p) => p !== "/" && !isConfigOrInternalPath(p, configDir)
      );
      // Sort longest paths first so children are removed before parents
      existingPaths.sort((a, b) => b.length - a.length);
      for (const path of existingPaths) {
        if (!virtualPaths.has(path)) {
          const item = internalVault.fileMap[path];
          const isFolder = item instanceof TFolder;
          internalVault.onChange?.(isFolder ? "folder-removed" : "file-removed", path);
        }
      }
    }

    // 2. Sort folders first by depth so parent folders are registered in Vault.fileMap before children
    const sorted = [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.path.split("/").length - b.path.split("/").length;
    });

    for (const entry of sorted) {
      if (entry.type === "folder") {
        this.applyVaultRawEvent({ type: "folder-created", path: entry.path });
      } else {
        this.applyVaultRawEvent({
          type: "file-created",
          path: entry.path,
          stat: { ctime: entry.ctime, mtime: entry.mtime, size: entry.size },
        });
      }
    }

    // 3. Re-initialize MetadataCache if needed and refresh File Explorer UI
    const internalMeta = this.app.metadataCache as InternalMetadataCache;
    try {
      internalMeta.initialize?.();
    } catch {
      // Ignore
    }

    this.refreshFileExplorerViews();
  }

  private async syncOpenViewsAndNotifyModified(
    normalizedPath: string,
    stat: { ctime: number; mtime: number; size: number },
    internalVault: InternalVault
  ): Promise<void> {
    try {
      const content = await this.app.vault.adapter.read(normalizedPath);
      const leaves = this.app.workspace.getLeavesOfType("markdown");

      for (const leaf of leaves) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === normalizedPath) {
          const anyView = view as MarkdownView & {
            data?: string;
            lastSavedData?: string;
            dirty?: boolean;
            requestSave?: { cancel?: () => void };
          };
          const currentViewData = view.getViewData();
          if (currentViewData !== content) {
            anyView.lastSavedData = content;
            anyView.data = content;
            anyView.dirty = false;
            view.setViewData(content, false);
            anyView.dirty = false;
            anyView.requestSave?.cancel?.();
          } else {
            anyView.lastSavedData = content;
            anyView.data = content;
          }
        }
      }
    } catch {
      // Ignore if file was deleted concurrently
    }

    internalVault.onChange?.("modified", normalizedPath, normalizedPath, stat);
  }

  private refreshFileExplorerViews(): void {
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of leaves) {
      const anyView = leaf.view as { requestSort?: () => void };
      anyView.requestSort?.();
    }
  }
}
