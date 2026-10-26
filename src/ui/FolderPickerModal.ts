import { App, ButtonComponent, Modal, Notice, TextComponent } from "obsidian";
import { DriveClient } from "../drive/DriveClient";
import { DriveFileMetadata } from "../types";

interface BreadcrumbItem {
  id: string;
  name: string;
}

export class FolderPickerModal extends Modal {
  private breadcrumbs: BreadcrumbItem[] = [{ id: "root", name: "My Drive" }];
  private listContainerEl!: HTMLElement;
  private breadcrumbEl!: HTMLElement;
  private newFolderName = "";

  constructor(
    app: App,
    private readonly driveClient: DriveClient,
    private readonly onSelect: (folder: DriveFileMetadata) => Promise<void>
  ) {
    super(app);
  }

  public async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Choose Google Drive Vault Folder" });

    // Breadcrumb & Current Folder Header
    const headerRow = contentEl.createDiv({
      attr: {
        style:
          "display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; padding: 8px 10px; border-radius: 6px; background: var(--background-secondary);",
      },
    });

    this.breadcrumbEl = headerRow.createDiv({
      attr: { style: "font-size: 0.9em; font-weight: 500; overflow: hidden; text-overflow: ellipsis;" },
    });

    const selectCurrentBtn = new ButtonComponent(headerRow)
      .setButtonText("Use Current Folder")
      .setCta()
      .onClick(async () => {
        const current = this.breadcrumbs[this.breadcrumbs.length - 1];
        if (current.id === "root") {
          new Notice("Please select or create a folder inside My Drive rather than mounting root.");
          return;
        }
        this.close();
        await this.onSelect({
          id: current.id,
          name: current.name,
          mimeType: "application/vnd.google-apps.folder",
        });
      });
    selectCurrentBtn.buttonEl.style.flexShrink = "0";

    // Folder List Area
    this.listContainerEl = contentEl.createDiv({
      attr: {
        style:
          "max-height: 280px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 6px; margin-bottom: 12px;",
      },
    });

    // Create New Folder Row
    const createRow = contentEl.createDiv({
      attr: {
        style: "display: flex; gap: 8px; align-items: center;",
      },
    });

    const nameInput = new TextComponent(createRow)
      .setPlaceholder("New folder name (e.g. ObsidianVault)...")
      .onChange((val) => {
        this.newFolderName = val.trim();
      });
    nameInput.inputEl.style.flex = "1";

    new ButtonComponent(createRow)
      .setButtonText("Create & Select")
      .onClick(async () => {
        if (!this.newFolderName) {
          new Notice("Enter a folder name first.");
          return;
        }
        const parent = this.breadcrumbs[this.breadcrumbs.length - 1];
        try {
          new Notice(`Creating folder "${this.newFolderName}"...`);
          const created = await this.driveClient.createFolder(this.newFolderName, parent.id);
          this.close();
          await this.onSelect(created);
        } catch (err) {
          new Notice(
            `Failed to create folder: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      });

    await this.renderCurrentFolder();
  }

  private async renderCurrentFolder(): Promise<void> {
    this.breadcrumbEl.empty();
    this.breadcrumbs.forEach((crumb, idx) => {
      if (idx > 0) {
        this.breadcrumbEl.createSpan({
          text: " / ",
          attr: { style: "color: var(--text-muted);" },
        });
      }
      const link = this.breadcrumbEl.createSpan({
        text: crumb.name,
        attr: {
          style:
            idx === this.breadcrumbs.length - 1
              ? "font-weight: 600;"
              : "cursor: pointer; text-decoration: underline; color: var(--text-accent);",
        },
      });
      if (idx < this.breadcrumbs.length - 1) {
        link.addEventListener("click", () => {
          this.breadcrumbs = this.breadcrumbs.slice(0, idx + 1);
          void this.renderCurrentFolder();
        });
      }
    });

    this.listContainerEl.empty();
    this.listContainerEl.createDiv({
      text: "Loading folders from Google Drive...",
      attr: { style: "padding: 12px; color: var(--text-muted); font-size: 0.9em;" },
    });

    const currentParent = this.breadcrumbs[this.breadcrumbs.length - 1];
    try {
      const folders = await this.driveClient.listFolders(currentParent.id);
      this.listContainerEl.empty();

      if (folders.length === 0) {
        this.listContainerEl.createDiv({
          text: "No subfolders inside this folder. Click 'Use Current Folder' above or create a new folder below.",
          attr: { style: "padding: 12px; color: var(--text-muted); font-size: 0.9em;" },
        });
        return;
      }

      for (const folder of folders) {
        const row = this.listContainerEl.createDiv({
          attr: {
            style:
              "display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; border-radius: 4px; gap: 8px;",
          },
        });

        const openFolderBtn = row.createDiv({
          text: `📁 ${folder.name}`,
          attr: {
            style: "cursor: pointer; flex: 1; font-weight: 500;",
            title: "Click to open subfolder",
          },
        });
        openFolderBtn.addEventListener("click", () => {
          this.breadcrumbs.push({ id: folder.id, name: folder.name });
          void this.renderCurrentFolder();
        });

        new ButtonComponent(row)
          .setButtonText("Select")
          .onClick(async () => {
            this.close();
            await this.onSelect(folder);
          });
      }
    } catch (err) {
      this.listContainerEl.empty();
      this.listContainerEl.createDiv({
        text: `Failed to list folders: ${err instanceof Error ? err.message : String(err)}`,
        attr: { style: "padding: 12px; color: var(--text-error);" },
      });
    }
  }

  public onClose(): void {
    this.contentEl.empty();
  }
}
