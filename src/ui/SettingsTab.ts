import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type GoogleDriveVaultPlugin from "../main";
import { ManualOAuthModal } from "./MobileAuthModal";

export class GoogleDriveSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GoogleDriveVaultPlugin) {
    super(app, plugin);
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian Drive View" });

    // Status Banner
    const statusBanner = containerEl.createDiv({
      attr: {
        style:
          "padding: 12px; border-radius: 6px; margin-bottom: 16px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border);",
      },
    });
    const isAuth = this.plugin.oauth.isAuthenticated();
    const isMounted = this.plugin.mounter.isMounted();
    statusBanner.createEl("div", {
      text: `Status: ${this.plugin.currentSyncState.toUpperCase()} — ${this.plugin.currentSyncDetail}`,
      attr: { style: "font-weight: 600; margin-bottom: 4px;" },
    });
    statusBanner.createEl("div", {
      text: `Adapter Mounted: ${isMounted ? "Yes (Google Drive Virtual Backend Active)" : "No (Local Stub Mode)"} | Cached Items: ${this.plugin.cache.getAllEntries().length}`,
      attr: { style: "font-size: 0.9em; color: var(--text-muted);" },
    });

    // 1. Authentication Section
    containerEl.createEl("h3", { text: "1. Google OAuth 2.0 Credentials" });

    const detailsEl = containerEl.createEl("details", {
      attr: { style: "margin-bottom: 12px; font-size: 0.9em; color: var(--text-muted);" },
    });
    detailsEl.createEl("summary", {
      text: "Quick 60-second setup guide for Google OAuth Client ID",
      attr: { style: "cursor: pointer; font-weight: 500; color: var(--text-normal);" },
    });
    const guideList = detailsEl.createEl("ol", { attr: { style: "margin-top: 8px;" } });
    guideList.createEl("li", {
      text: "Open console.cloud.google.com, create/select a project, and enable the 'Google Drive API'.",
    });
    guideList.createEl("li", {
      text: "Go to 'APIs & Services -> Credentials -> Create Credentials -> OAuth client ID'.",
    });
    guideList.createEl("li", {
      text: "Choose Application Type: 'Desktop app' (or 'iOS' for secretless PKCE) and paste the Client ID (and Client Secret if Desktop app) below.",
    });

    new Setting(containerEl)
      .setName("Google OAuth Client ID")
      .setDesc("OAuth 2.0 Client ID from Google Cloud Console (.apps.googleusercontent.com)")
      .addText((text) =>
        text
          .setPlaceholder("123456789-abc.apps.googleusercontent.com")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ clientId: value.trim() });
          })
      );

    new Setting(containerEl)
      .setName("Google OAuth Client Secret (Optional for PKCE)")
      .setDesc("Required by Google only if using a 'Desktop app' Client ID type")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("GOCSPX-...")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ clientSecret: value.trim() });
          });
      });

    const authSetting = new Setting(containerEl)
      .setName("Google Account Connection")
      .setDesc(
        isAuth
          ? "Connected to Google Drive. You can re-authenticate or export an auth bundle for mobile."
          : "Not signed in yet."
      );

    if (Platform.isDesktopApp) {
      authSetting.addButton((btn) =>
        btn
          .setButtonText(isAuth ? "Re-authenticate (Browser)" : "Sign in with Google")
          .setCta()
          .onClick(async () => {
            try {
              new Notice("Opening browser for Google Sign-In...");
              await this.plugin.oauth.startDesktopLoopbackFlow((url) => {
                window.open(url, "_blank");
              });
              new Notice("Connected to Google Drive!");
              await this.plugin.connectAndMountDriveVault();
              this.display();
            } catch (err) {
              new Notice(`Sign-in error: ${err instanceof Error ? err.message : String(err)}`);
            }
          })
      );
    }

    authSetting.addButton((btn) =>
      btn
        .setButtonText(Platform.isDesktopApp ? "Manual / Mobile Code Flow" : "Sign in with Google")
        .onClick(() => {
          new ManualOAuthModal(this.app, this.plugin.oauth, async () => {
            await this.plugin.connectAndMountDriveVault();
            this.display();
          }).open();
        })
    );

    // Quick Mobile Transfer Bundle (Export on Desktop -> Paste on Mobile in 1 click)
    new Setting(containerEl)
      .setName("Quick Cross-Device Auth Bundle (Desktop ↔ Mobile)")
      .setDesc(
        "Already signed in on Desktop? Copy the Auth Bundle and paste it on Mobile to skip logging in again."
      )
      .addButton((btn) =>
        btn.setButtonText("Copy Auth Bundle").onClick(async () => {
          const bundle = btoa(
            JSON.stringify({
              clientId: this.plugin.settings.clientId,
              clientSecret: this.plugin.settings.clientSecret,
              refreshToken: this.plugin.settings.refreshToken,
              rootFolderId: this.plugin.settings.rootFolderId,
              rootFolderName: this.plugin.settings.rootFolderName,
            })
          );
          await navigator.clipboard.writeText(bundle);
          new Notice("Copied Auth Bundle to clipboard!");
        })
      )
      .addText((text) =>
        text.setPlaceholder("Paste Auth Bundle here...").onChange(async (val) => {
          if (!val.trim()) return;
          try {
            const decoded = JSON.parse(atob(val.trim()));
            if (decoded.clientId && decoded.refreshToken) {
              await this.plugin.updateSettings({
                clientId: decoded.clientId,
                clientSecret: decoded.clientSecret || "",
                refreshToken: decoded.refreshToken,
                rootFolderId: decoded.rootFolderId || this.plugin.settings.rootFolderId,
                rootFolderName: decoded.rootFolderName || this.plugin.settings.rootFolderName,
                accessToken: "",
                tokenExpiresAt: 0,
              });
              new Notice("Imported Auth Bundle! Connecting to Google Drive...");
              await this.plugin.connectAndMountDriveVault();
              this.display();
            }
          } catch {
            // Wait until valid base64 JSON is pasted
          }
        })
      );

    // 2. Vault Root Folder Section
    containerEl.createEl("h3", { text: "2. Google Drive Vault Folder" });

    new Setting(containerEl)
      .setName("Root Folder Name in Google Drive")
      .setDesc("Name of the folder in My Drive that stores this vault's files")
      .addText((text) =>
        text
          .setPlaceholder("ObsidianDriveVault")
          .setValue(this.plugin.settings.rootFolderName)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              rootFolderName: value.trim() || "ObsidianDriveVault",
            });
          })
      );

    new Setting(containerEl)
      .setName("Root Folder ID (Auto-detected or Custom)")
      .setDesc(
        "Leave blank to automatically find/create the folder by name, or paste a specific Google Drive Folder ID."
      )
      .addText((text) =>
        text
          .setPlaceholder("Auto-filled upon connection")
          .setValue(this.plugin.settings.rootFolderId)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ rootFolderId: value.trim() });
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Verify / Connect Folder")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.connectAndMountDriveVault(true);
              this.display();
            } catch (err) {
              new Notice(`Folder connection failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })
      );

    // 3. Backend Adapter & Sync Controls
    containerEl.createEl("h3", { text: "3. Virtual Adapter & Sync Settings" });

    new Setting(containerEl)
      .setName("Enable Google Drive Vault Backend")
      .setDesc(
        "When enabled, replaces Obsidian's local filesystem DataAdapter with the virtual Google Drive adapter."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.adapterEnabled).onChange(async (val) => {
          await this.plugin.updateSettings({ adapterEnabled: val });
          if (val) {
            await this.plugin.connectAndMountDriveVault();
          } else {
            await this.plugin.unmountDriveVault();
          }
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Manual Sync & Cache Operations")
      .setDesc("Pull remote changes now, flush pending uploads, or force a full re-index from Drive.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").onClick(async () => {
          await this.plugin.syncNow();
          this.display();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Rebuild Cache from Drive")
          .setWarning()
          .onClick(async () => {
            await this.plugin.rebuildCacheFromDrive();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Write Debounce Delay (ms)")
      .setDesc(
        "How long to wait after typing stops before uploading a modified note to Google Drive (default: 2500 ms)."
      )
      .addText((text) =>
        text.setValue(String(this.plugin.settings.writeDebounceMs)).onChange(async (val) => {
          const num = parseInt(val, 10);
          if (!isNaN(num) && num >= 250) {
            await this.plugin.updateSettings({ writeDebounceMs: num });
          }
        })
      );

    new Setting(containerEl)
      .setName("Remote Change Poll Interval (seconds)")
      .setDesc("How often to check Google Drive changes.list for remote updates (default: 30s).")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.pollIntervalSec)).onChange(async (val) => {
          const num = parseInt(val, 10);
          if (!isNaN(num) && num >= 10) {
            await this.plugin.updateSettings({ pollIntervalSec: num });
            this.plugin.restartPollingTimer();
          }
        })
      );

    new Setting(containerEl)
      .setName("Prefetch Binary Attachments for Embeds")
      .setDesc(
        "Automatically caches images/PDFs in IndexedDB so embedded ![[image.png]] links render synchronously via blob: URLs."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.prefetchBinaries).onChange(async (val) => {
          await this.plugin.updateSettings({ prefetchBinaries: val });
        })
      );
  }
}
