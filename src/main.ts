import { Notice, Platform, Plugin } from "obsidian";
import { GoogleDriveDataAdapter } from "./adapter/GoogleDriveDataAdapter";
import { VaultMounter } from "./adapter/VaultMounter";
import { GoogleOAuthManager } from "./auth/GoogleOAuth";
import { VirtualVaultCache } from "./cache/IndexedDbCache";
import { DriveClient } from "./drive/DriveClient";
import { DEFAULT_SETTINGS, GoogleDriveSettings, SyncState } from "./types";
import { GoogleDriveSettingTab } from "./ui/SettingsTab";

export default class GoogleDriveVaultPlugin extends Plugin {
  public settings: GoogleDriveSettings = { ...DEFAULT_SETTINGS };
  public oauth!: GoogleOAuthManager;
  public driveClient!: DriveClient;
  public cache!: VirtualVaultCache;
  public driveAdapter!: GoogleDriveDataAdapter;
  public mounter!: VaultMounter;

  public currentSyncState: SyncState = "disconnected";
  public currentSyncDetail = "Not connected";

  private statusBarItemEl: HTMLElement | null = null;
  private pollIntervalId: number | null = null;
  private isPolling = false;

  public async onload(): Promise<void> {
    await this.loadSettings();

    this.oauth = new GoogleOAuthManager(
      () => this.settings,
      async (partial) => {
        await this.updateSettings(partial);
      }
    );

    this.driveClient = new DriveClient(this.oauth);
    this.cache = new VirtualVaultCache(this.app.vault.getName());
    await this.cache.open();

    this.mounter = new VaultMounter(this.app);

    this.driveAdapter = new GoogleDriveDataAdapter(
      this.mounter.getOriginalAdapter(),
      this.cache,
      this.driveClient,
      () => this.settings,
      this.app.vault.configDir || ".obsidian",
      (state, detail) => this.setSyncState(state, detail),
      (evt) => {
        this.mounter.applyVaultRawEvent(evt);
      }
    );

    if (Platform.isDesktopApp) {
      this.statusBarItemEl = this.addStatusBarItem();
      this.updateStatusBarUi();
    }

    this.addRibbonIcon("cloud", "Drive View: Sync now", async () => {
      await this.syncNow();
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now with Google Drive",
      callback: async () => {
        await this.syncNow();
      },
    });

    this.addCommand({
      id: "flush-uploads",
      name: "Flush pending uploads immediately",
      callback: async () => {
        await this.driveAdapter.flushAllPendingUploads();
        new Notice("All pending uploads flushed to Google Drive.");
      },
    });

    this.addCommand({
      id: "rebuild-cache",
      name: "Rebuild local IndexedDB cache from Google Drive",
      callback: async () => {
        await this.rebuildCacheFromDrive();
      },
    });

    this.addSettingTab(new GoogleDriveSettingTab(this.app, this));

    // Mount immediately from IndexedDB cache if already configured, then sync with Drive
    this.app.workspace.onLayoutReady(async () => {
      if (this.oauth.isAuthenticated()) {
        await this.connectAndMountDriveVault();
      } else {
        this.setSyncState(
          "disconnected",
          "Sign in to Google Drive in plugin settings"
        );
      }
    });
  }

  public async onunload(): Promise<void> {
    this.stopPollingTimer();
    await this.mounter.unmount(this.driveAdapter);
    this.cache.close();
  }

  public async loadSettings(): Promise<void> {
    const raw = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
  }

  public async updateSettings(partial: Partial<GoogleDriveSettings>): Promise<void> {
    this.settings = Object.assign({}, this.settings, partial);
    // Always persist plugin settings through the original local adapter so data.json stays in .obsidian
    await this.saveData(this.settings);
  }

  public async connectAndMountDriveVault(forceFolderLookup = false): Promise<void> {
    if (!this.oauth.isAuthenticated()) {
      this.setSyncState("disconnected", "Not signed in to Google Drive");
      return;
    }

    try {
      // 1. If we already have cached entries in IndexedDB, mount the virtual adapter right away for instant startup
      if (this.cache.hasEntries() && !this.mounter.isMounted()) {
        await this.mounter.mount(this.driveAdapter);
      }

      // 2. Ensure root folder exists on Google Drive
      this.setSyncState("indexing", "Connecting to Google Drive root folder...");
      const rootMeta = await this.driveClient.ensureRootFolder(
        this.settings.rootFolderName || "ObsidianDriveVault",
        forceFolderLookup ? this.settings.rootFolderId : this.settings.rootFolderId
      );

      if (rootMeta.id !== this.settings.rootFolderId) {
        await this.updateSettings({ rootFolderId: rootMeta.id, rootFolderName: rootMeta.name });
      }

      // 3. Fetch latest file tree and prefetch text/markdown content
      await this.driveAdapter.initializeFromDrive(rootMeta.id, false);

      // 4. Mount or reconcile the full vault in Obsidian
      if (!this.mounter.isMounted()) {
        await this.mounter.mount(this.driveAdapter);
      } else {
        await this.mounter.reconcileFullVault(this.driveAdapter);
      }

      this.restartPollingTimer();
      this.setSyncState("synced", `Connected to "${rootMeta.name}"`);
    } catch (err) {
      console.error("[GoogleDriveVaultPlugin] Failed to connect and mount Drive vault:", err);
      this.setSyncState(
        "error",
        err instanceof Error ? err.message : "Failed to connect to Google Drive"
      );
      new Notice(
        `Google Drive Vault error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public async unmountDriveVault(): Promise<void> {
    this.stopPollingTimer();
    await this.mounter.unmount(this.driveAdapter);
    this.setSyncState("disconnected", "Google Drive adapter unmounted");
    new Notice("Unmounted Google Drive backend and restored local adapter.");
  }

  public async syncNow(): Promise<void> {
    if (!this.oauth.isAuthenticated() || !this.settings.rootFolderId) {
      new Notice("Google Drive Vault is not connected yet.");
      return;
    }

    if (this.isPolling) return;
    this.isPolling = true;

    try {
      this.setSyncState("syncing", "Syncing changes with Google Drive...");
      await this.driveAdapter.flushAllPendingUploads();
      const applied = await this.driveAdapter.pollRemoteChanges(this.settings.rootFolderId);
      if (this.settings.syncConfigDir) {
        await this.driveAdapter.reconcileConfigDirWithDrive();
      }
      this.setSyncState(
        "synced",
        applied > 0 ? `Pulled ${applied} remote change(s)` : "Up to date"
      );
    } catch (err) {
      console.error("[GoogleDriveVaultPlugin] Sync error:", err);
      this.setSyncState("error", err instanceof Error ? err.message : "Sync error");
    } finally {
      this.isPolling = false;
    }
  }

  public async rebuildCacheFromDrive(): Promise<void> {
    if (!this.oauth.isAuthenticated() || !this.settings.rootFolderId) {
      new Notice("Please sign in and connect a Google Drive folder first.");
      return;
    }

    try {
      new Notice("Rebuilding local cache from Google Drive...");
      await this.driveAdapter.flushAllPendingUploads();
      await this.cache.clearAll();
      await this.driveAdapter.initializeFromDrive(this.settings.rootFolderId, true);
      await this.mounter.reconcileFullVault(this.driveAdapter);
      new Notice("Successfully rebuilt vault cache from Google Drive!");
    } catch (err) {
      new Notice(`Failed to rebuild cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public restartPollingTimer(): void {
    this.stopPollingTimer();
    if (!this.oauth.isAuthenticated()) return;

    const intervalMs = Math.max(10, this.settings.pollIntervalSec || 30) * 1000;
    this.pollIntervalId = window.setInterval(() => {
      if (!this.isPolling && this.mounter.isMounted() && this.settings.rootFolderId) {
        void this.syncNow();
      }
    }, intervalMs);
    this.registerInterval(this.pollIntervalId);
  }

  private stopPollingTimer(): void {
    if (this.pollIntervalId !== null) {
      window.clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
  }

  private setSyncState(state: SyncState, detail?: string): void {
    this.currentSyncState = state;
    if (detail) {
      this.currentSyncDetail = detail;
    }
    this.updateStatusBarUi();
  }

  private updateStatusBarUi(): void {
    if (!this.statusBarItemEl) return;
    const labels: Record<SyncState, string> = {
      disconnected: "Drive: Disconnected",
      authenticating: "Drive: Signing in...",
      indexing: "Drive: Indexing...",
      synced: "Drive: Synced",
      syncing: "Drive: Syncing...",
      offline: "Drive: Offline",
      error: "Drive: Error",
    };
    this.statusBarItemEl.setText(labels[this.currentSyncState] || "Drive");
    this.statusBarItemEl.setAttr("title", this.currentSyncDetail);
  }
}
