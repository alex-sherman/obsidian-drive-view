import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type GoogleDriveVaultPlugin from "../main";
import { FolderPickerModal } from "./FolderPickerModal";
import { ManualOAuthModal } from "./MobileAuthModal";

export class GoogleDriveSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GoogleDriveVaultPlugin) {
    super(app, plugin);
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Drive View").setHeading();

    // Status Banner
    const statusBanner = containerEl.createDiv({
      attr: {
        style:
          "padding: 12px; border-radius: 6px; margin-bottom: 16px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border);",
      },
    });
    const isAuth = this.plugin.oauth.isAuthenticated();
    const isMounted = this.plugin.mounter.isMounted();
    statusBanner.createDiv({
      text: `Status: ${this.plugin.currentSyncState.toUpperCase()} — ${this.plugin.currentSyncDetail}`,
      attr: { style: "font-weight: 600; margin-bottom: 4px;" },
    });
    statusBanner.createDiv({
      text: `Adapter Mounted: ${isMounted ? "Yes (Google Drive Virtual Backend Active)" : "No (Local Stub Mode)"} | Cached Items: ${this.plugin.cache.getAllEntries().length}`,
      attr: { style: "font-size: 0.9em; color: var(--text-muted);" },
    });

    // 1. Google Account Section
    new Setting(containerEl).setName("1. Google Account").setHeading();

    const authSetting = new Setting(containerEl)
      .setName("Google Drive Account")
      .setDesc(
        isAuth
          ? "Connected to Google Drive."
          : "Sign in with your Google account to mount a Drive folder as your vault."
      );

    authSetting.addButton((btn) =>
      btn
        .setButtonText(isAuth ? "Re-authenticate" : "Sign in with Google")
        .setCta()
        .onClick(async () => {
          try {
            new Notice("Opening browser for Google Sign-In...");
            await this.plugin.oauth.startLoginFlow((url) => {
              window.open(url, "_blank");
            });
          } catch (err) {
            new Notice(`Sign-in error: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
    );

    authSetting.addButton((btn) =>
      btn
        .setButtonText("Manual Code")
        .onClick(() => {
          new ManualOAuthModal(this.app, this.plugin.oauth, async () => {
            await this.plugin.connectAndMountDriveVault();
            this.display();
          }).open();
        })
    );

    if (isAuth) {
      authSetting.addButton((btn) =>
        btn
          .setButtonText("Sign Out")
          .setWarning()
          .onClick(async () => {
            await this.plugin.unmountDriveVault();
            await this.plugin.oauth.signOut();
            new Notice("Signed out of Google Drive.");
            this.display();
          })
      );
    }

    new Setting(containerEl)
      .setName("Use Custom OAuth Credentials (Full Drive & Shared Folders)")
      .setDesc(
        "By default, Drive View requests per-file access (drive.file) for folders created by this app. Enable this to provide your own Google Cloud Web Client ID & Secret for full Drive and shared folder access."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useCustomCredentials).onChange(async (val) => {
          await this.plugin.updateSettings({ useCustomCredentials: val });
          this.display();
        })
      );

    if (this.plugin.settings.useCustomCredentials) {
      new Setting(containerEl)
        .setName("Custom Google OAuth Client ID")
        .setDesc("Your Google Cloud OAuth 2.0 Web Application Client ID.")
        .addText((text) =>
          text
            .setPlaceholder("123456789-abc...apps.googleusercontent.com")
            .setValue(this.plugin.settings.customClientId)
            .onChange(async (val) => {
              await this.plugin.updateSettings({ customClientId: val.trim() });
            })
        );

      new Setting(containerEl)
        .setName("Custom Google OAuth Client Secret")
        .setDesc(
          "Your Web Client Secret. In Google Cloud Console, add https://asherman.io/drive-view/auth to Authorized redirect URIs."
        )
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("GOCSPX-...")
            .setValue(this.plugin.settings.customClientSecret)
            .onChange(async (val) => {
              await this.plugin.updateSettings({ customClientSecret: val.trim() });
            });
        });
    }

    // 2. Vault Root Folder Section
    new Setting(containerEl).setName("2. Google Drive Vault Folder").setHeading();

    const folderDesc = this.plugin.settings.rootFolderId
      ? `Active folder: "${this.plugin.settings.rootFolderName}"`
      : "No folder selected yet.";

    new Setting(containerEl)
      .setName("Vault Folder in Google Drive")
      .setDesc(folderDesc)
      .addButton((btn) =>
        btn
          .setButtonText("Browse / Create Folder...")
          .setCta()
          .onClick(() => {
            if (!this.plugin.oauth.isAuthenticated()) {
              new Notice("Please sign in with Google first.");
              return;
            }
            new FolderPickerModal(
              this.app,
              this.plugin.driveClient,
              async (selectedFolder) => {
                await this.plugin.updateSettings({
                  rootFolderId: selectedFolder.id,
                  rootFolderName: selectedFolder.name,
                });
                await this.plugin.rebuildCacheFromDrive();
                this.display();
              }
            ).open();
          })
      );

    const configFolder = this.app.vault.configDir;
    new Setting(containerEl)
      .setName(`Sync Vault Settings & Plugins (${configFolder})`)
      .setDesc(
        `Mirrors core settings, themes, snippets, and installed plugins between your local ${configFolder} folder and Google Drive (excludes workspace layout and this plugin's auth state).`
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncConfigDir).onChange(async (val) => {
          await this.plugin.updateSettings({ syncConfigDir: val });
          if (val && this.plugin.oauth.isAuthenticated() && this.plugin.settings.rootFolderId) {
            new Notice(`Syncing ${configFolder} settings & plugins with Google Drive...`);
            const { pulled, pushed } =
              await this.plugin.driveAdapter.reconcileConfigDirWithDrive();
            new Notice(
              `${configFolder} sync complete (${pulled} pulled from Drive, ${pushed} uploaded to Drive).`
            );
            this.display();
          }
        })
      );

    // 3. Advanced Settings (Collapsible Dropdown)
    const advancedDetails = containerEl.createEl("details", {
      attr: {
        style:
          "margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--background-modifier-border);",
      },
    });
    advancedDetails.createEl("summary", {
      text: "Advanced",
      attr: {
        style: "cursor: pointer; font-weight: 600; font-size: 1.1em; margin-bottom: 12px;",
      },
    });

    const advancedContainer = advancedDetails.createDiv({
      attr: { style: "margin-top: 12px;" },
    });

    new Setting(advancedContainer)
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

    new Setting(advancedContainer)
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

    new Setting(advancedContainer)
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

    new Setting(advancedContainer)
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
