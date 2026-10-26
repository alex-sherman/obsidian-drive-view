declare module "obsidian" {
  export interface Stat {
    type: "file" | "folder";
    ctime: number;
    mtime: number;
    size: number;
  }

  export interface ListedFiles {
    files: string[];
    folders: string[];
  }

  export interface DataWriteOptions {
    ctime?: number;
    mtime?: number;
    immediate?: () => void;
  }

  export interface DataAdapter {
    getName(): string;
    exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
    stat(normalizedPath: string): Promise<Stat | null>;
    list(normalizedPath: string): Promise<ListedFiles>;
    read(normalizedPath: string): Promise<string>;
    readBinary(normalizedPath: string): Promise<ArrayBuffer>;
    write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
    writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
    append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
    appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
    process(
      normalizedPath: string,
      fn: (data: string) => string,
      options?: DataWriteOptions
    ): Promise<string>;
    getResourcePath(normalizedPath: string): string;
    mkdir(normalizedPath: string): Promise<void>;
    trashSystem(normalizedPath: string): Promise<boolean>;
    trashLocal(normalizedPath: string): Promise<void>;
    rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
    remove(normalizedPath: string): Promise<void>;
    rename(normalizedPath: string, normalizedNewPath: string): Promise<void>;
    copy(normalizedPath: string, normalizedNewPath: string): Promise<void>;
  }

  export abstract class TAbstractFile {
    vault: Vault;
    path: string;
    name: string;
    parent: TFolder | null;
  }

  export class TFolder extends TAbstractFile {
    children: TAbstractFile[];
    isRoot(): boolean;
  }

  export class TFile extends TAbstractFile {
    stat: Stat;
    basename: string;
    extension: string;
  }

  export class Vault {
    adapter: DataAdapter;
    configDir: string;
    getName(): string;
    getAbstractFileByPath(path: string): TAbstractFile | null;
    getFileByPath(path: string): TFile | null;
    getFolderByPath(path: string): TFolder | null;
    getRoot(): TFolder;
  }

  export class WorkspaceLeaf {
    view: unknown;
  }

  export class MarkdownView {
    file: TFile | null;
    getViewData(): string;
    setViewData(data: string, clear: boolean): void;
  }

  export class Workspace {
    onLayoutReady(callback: () => unknown): void;
    getLeavesOfType(viewType: string): WorkspaceLeaf[];
  }

  export class MetadataCache {}

  export class App {
    vault: Vault;
    workspace: Workspace;
    metadataCache: MetadataCache;
  }

  export interface Command {
    id: string;
    name: string;
    callback?: () => unknown;
  }

  export class Plugin {
    app: App;
    onload(): Promise<void> | void;
    onunload(): Promise<void> | void;
    addStatusBarItem(): HTMLElement;
    addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement;
    addCommand(command: Command): Command;
    addSettingTab(settingTab: PluginSettingTab): void;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
    registerInterval(id: number): number;
    registerObsidianProtocolHandler(
      action: string,
      handler: (params: Record<string, string>) => unknown
    ): void;
  }

  export class PluginSettingTab {
    app: App;
    containerEl: HTMLElement;
    constructor(app: App, plugin: Plugin);
    display(): void;
    hide(): void;
  }

  export class Modal {
    app: App;
    contentEl: HTMLElement;
    constructor(app: App);
    open(): void;
    close(): void;
    onOpen(): void;
    onClose(): void;
  }

  export class ButtonComponent {
    buttonEl: HTMLButtonElement;
    constructor(containerEl: HTMLElement);
    setButtonText(name: string): this;
    setCta(): this;
    setWarning(): this;
    onClick(callback: (evt: MouseEvent) => unknown): this;
  }

  export class TextComponent {
    inputEl: HTMLInputElement;
    constructor(containerEl: HTMLElement);
    setPlaceholder(placeholder: string): this;
    setValue(value: string): this;
    onChange(callback: (value: string) => unknown): this;
  }

  export class ToggleComponent {
    toggleEl: HTMLElement;
    setValue(on: boolean): this;
    onChange(callback: (value: boolean) => unknown): this;
  }

  export class Setting {
    settingEl: HTMLElement;
    constructor(containerEl: HTMLElement);
    setName(name: string): this;
    setDesc(desc: string): this;
    setHeading(): this;
    addText(cb: (component: TextComponent) => unknown): this;
    addButton(cb: (component: ButtonComponent) => unknown): this;
    addToggle(cb: (component: ToggleComponent) => unknown): this;
  }

  export class Notice {
    constructor(message: string, timeout?: number);
  }

  export const Platform: {
    isDesktop: boolean;
    isMobile: boolean;
    isDesktopApp: boolean;
    isMobileApp: boolean;
    isIosApp: boolean;
    isAndroidApp: boolean;
  };

  export interface RequestUrlParam {
    url: string;
    method?: string;
    contentType?: string;
    body?: string | ArrayBuffer;
    headers?: Record<string, string>;
    throw?: boolean;
  }

  export interface RequestUrlResponse {
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
    json: unknown;
    text: string;
  }

  export function requestUrl(request: RequestUrlParam | string): Promise<RequestUrlResponse>;
}

interface HTMLElement {
  empty(): void;
  setText(val: string): void;
  setAttr(key: string, val: string): void;
  setCssStyles(styles: Partial<CSSStyleDeclaration> | Record<string, string>): void;
  setCssProps(props: Record<string, string>): void;
  createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    o?: { text?: string; cls?: string; attr?: Record<string, string> }
  ): HTMLElementTagNameMap[K];
  createDiv(o?: { text?: string; cls?: string; attr?: Record<string, string> }): HTMLDivElement;
  createSpan(o?: { text?: string; cls?: string; attr?: Record<string, string> }): HTMLSpanElement;
}
