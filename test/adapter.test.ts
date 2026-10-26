import { test, expect, mock } from "bun:test";
import type { DataAdapter } from "obsidian";
import type { DriveClient } from "../src/drive/DriveClient";
import type { GoogleDriveSettings } from "../src/types";
import type { ObsidianVaultRawEvent } from "../src/adapter/GoogleDriveDataAdapter";

// Mock the runtime "obsidian" module before dynamically importing plugin modules
mock.module("obsidian", () => ({
  Platform: { isDesktopApp: true, isMobileApp: false },
  requestUrl: async () => ({ status: 200, text: "", json: {} }),
}));

function createMockBaseAdapter(): DataAdapter & { localFiles: Map<string, string> } {
  const localFiles = new Map<string, string>();
  return {
    localFiles,
    getName: () => "TestVault",
    exists: async (p: string) => localFiles.has(p),
    stat: async (p: string) =>
      localFiles.has(p)
        ? { type: "file", ctime: 1, mtime: 1, size: localFiles.get(p)!.length }
        : null,
    list: async () => ({ files: Array.from(localFiles.keys()), folders: [] }),
    read: async (p: string) => localFiles.get(p) ?? "",
    readBinary: async (p: string) => new TextEncoder().encode(localFiles.get(p) ?? "").buffer,
    write: async (p: string, data: string) => {
      localFiles.set(p, data);
    },
    writeBinary: async (p: string, buf: ArrayBuffer) => {
      localFiles.set(p, new TextDecoder().decode(buf));
    },
    append: async (p: string, data: string) => {
      localFiles.set(p, (localFiles.get(p) ?? "") + data);
    },
    appendBinary: async () => {},
    process: async (p: string, fn: (data: string) => string) => {
      const next = fn(localFiles.get(p) ?? "");
      localFiles.set(p, next);
      return next;
    },
    getResourcePath: (p: string) => `app://local/${p}`,
    mkdir: async () => {},
    trashSystem: async (p: string) => {
      localFiles.delete(p);
      return true;
    },
    trashLocal: async (p: string) => {
      localFiles.delete(p);
    },
    rmdir: async () => {},
    remove: async (p: string) => {
      localFiles.delete(p);
    },
    rename: async (oldP: string, newP: string) => {
      const v = localFiles.get(oldP) ?? "";
      localFiles.delete(oldP);
      localFiles.set(newP, v);
    },
    copy: async (src: string, dest: string) => {
      localFiles.set(dest, localFiles.get(src) ?? "");
    },
  };
}

function createMockDriveClient() {
  let idCounter = 100;
  const uploadedFiles: Array<{ id: string; name: string; parentId: string; data: unknown }> = [];
  const createdFolders: Array<{ id: string; name: string; parentId: string }> = [];
  const trashedIds: string[] = [];

  const client = {
    uploadedFiles,
    createdFolders,
    trashedIds,
    fetchFullVaultTree: async () => [
      {
        path: "Welcome.md",
        name: "Welcome.md",
        type: "file" as const,
        ctime: 1000,
        mtime: 2000,
        size: 14,
        driveId: "drive-welcome-1",
        parentId: "root-folder-id",
        md5Checksum: "abc123md5",
        mimeType: "text/markdown",
      },
    ],
    downloadBinary: async (fileId: string) => {
      if (fileId === "drive-welcome-1") {
        return new TextEncoder().encode("# Welcome Note").buffer;
      }
      if (fileId === "drive-remote-new") {
        return new TextEncoder().encode("Remote content\n\n&nbsp;\n\nBottom line").buffer;
      }
      return new ArrayBuffer(0);
    },
    createFolder: async (name: string, parentId: string) => {
      const id = `folder-${++idCounter}`;
      createdFolders.push({ id, name, parentId });
      return {
        id,
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      };
    },
    uploadFile: async (opts: {
      fileId?: string;
      name: string;
      parentId: string;
      mimeType: string;
      data: unknown;
    }) => {
      const id = opts.fileId || `file-${++idCounter}`;
      uploadedFiles.push({ id, name: opts.name, parentId: opts.parentId, data: opts.data });
      return {
        id,
        name: opts.name,
        mimeType: opts.mimeType,
        parents: [opts.parentId],
        md5Checksum: `md5-${uploadedFiles.length}`,
      };
    },
    moveOrRename: async (fileId: string, newName: string) => ({
      id: fileId,
      name: newName,
      mimeType: "text/markdown",
      modifiedTime: new Date().toISOString(),
    }),
    trashFile: async (fileId: string) => {
      trashedIds.push(fileId);
    },
    deleteFile: async (fileId: string) => {
      trashedIds.push(fileId);
    },
    getStartPageToken: async () => "token-1",
    listChanges: async () => ({
      newStartPageToken: "token-2",
      changes: [
        {
          fileId: "drive-remote-new",
          removed: false,
          file: {
            id: "drive-remote-new",
            name: "RemoteNote.md",
            mimeType: "text/markdown",
            parents: ["root-folder-id"],
            createdTime: new Date(3000).toISOString(),
            modifiedTime: new Date(4000).toISOString(),
            size: "14",
            md5Checksum: "remote-md5",
          },
        },
      ],
    }),
  };

  return client as unknown as DriveClient & typeof client;
}

test("GoogleDriveDataAdapter virtual filesystem & Drive sync lifecycle", async () => {
  const { normalizeVaultPath, driveMarkdownToObsidian, obsidianMarkdownToDrive } = await import(
    "../src/utils/pathUtils"
  );
  const { VirtualVaultCache } = await import("../src/cache/IndexedDbCache");
  const { GoogleDriveDataAdapter } = await import("../src/adapter/GoogleDriveDataAdapter");
  const { generatePkcePair, GoogleOAuthManager } = await import("../src/auth/GoogleOAuth");

  expect(normalizeVaultPath("/Folder//Subfolder/Note.md/")).toBe("Folder/Subfolder/Note.md");

  // Verify Google Docs &nbsp; <-> Obsidian blank line lossless conversion
  const driveSample =
    "3. What about conflict edits\n\n&nbsp;\n\nHere is some more on the bottom";
  const obsidianCleaned = driveMarkdownToObsidian(driveSample);
  expect(obsidianCleaned).toBe(
    "3. What about conflict edits\n\n\nHere is some more on the bottom"
  );
  expect(obsidianCleaned.includes("&nbsp;")).toBe(false);
  expect(obsidianMarkdownToDrive(obsidianCleaned)).toBe(driveSample);

  const baseAdapter = createMockBaseAdapter();
  const driveClient = createMockDriveClient();
  const cache = new VirtualVaultCache("unit-test-vault");
  await cache.open();

  const vaultEvents: ObsidianVaultRawEvent[] = [];
  const settings = {
    rootFolderId: "root-folder-id",
    refreshToken: "mock-refresh",
    accessToken: "mock-access",
    writeDebounceMs: 5000,
    prefetchBinaries: true,
    maxPrefetchBinarySizeMB: 10,
  } as unknown as GoogleDriveSettings;

  const adapter = new GoogleDriveDataAdapter(
    baseAdapter,
    cache,
    driveClient,
    () => settings,
    ".obsidian",
    undefined,
    (evt) => {
      vaultEvents.push(evt);
    }
  );

  const proxied = adapter.createProxiedAdapter();

  // 1. .obsidian paths should route exclusively to baseAdapter
  await proxied.write(".obsidian/app.json", '{"vimMode":true}');
  expect(baseAdapter.localFiles.get(".obsidian/app.json")).toBe('{"vimMode":true}');
  expect(cache.getEntry(".obsidian/app.json")).toBeUndefined();

  // 2. Initialize from Google Drive should index and prefetch Welcome.md
  await adapter.initializeFromDrive("root-folder-id");
  expect(await proxied.exists("Welcome.md")).toBe(true);
  expect(await proxied.exists("welcome.md", false)).toBe(true);
  expect(await proxied.exists("welcome.md", true)).toBe(false);
  expect(await proxied.read("Welcome.md")).toBe("# Welcome Note");

  // 3. Nested write should auto-create parent folders and coalesce rapid writes
  await proxied.write("Projects/2026/Plan.md", "Draft 1");
  await proxied.write("Projects/2026/Plan.md", "Draft 2");
  await proxied.write("Projects/2026/Plan.md", "Final Draft");

  expect(await proxied.read("Projects/2026/Plan.md")).toBe("Final Draft");
  const rootList = await proxied.list("");
  expect(rootList.folders).toEqual(["Projects"]);
  expect(rootList.files).toEqual(["Welcome.md"]);

  const projectsList = await proxied.list("Projects");
  expect(projectsList.folders).toEqual(["Projects/2026"]);

  // Flush pending uploads and verify only 1 upload occurred for Plan.md, plus parent folder chain creation
  await adapter.flushAllPendingUploads();
  expect(driveClient.createdFolders.length).toBe(2);
  expect(driveClient.uploadedFiles.length).toBe(1);
  expect(driveClient.uploadedFiles[0].name).toBe("Plan.md");

  // 4. Folder rename should update all nested children in the virtual file tree
  await proxied.rename("Projects", "Archive");
  expect(await proxied.exists("Projects/2026/Plan.md")).toBe(false);
  expect(await proxied.exists("Archive/2026/Plan.md")).toBe(true);
  expect(await proxied.read("Archive/2026/Plan.md")).toBe("Final Draft");

  // 5. Remote delta polling should pull new remote files, strip &nbsp;, and fire Vault file-created event
  vaultEvents.length = 0;
  const applied = await adapter.pollRemoteChanges("root-folder-id");
  expect(applied).toBe(1);
  expect(await proxied.exists("RemoteNote.md")).toBe(true);
  expect(await proxied.read("RemoteNote.md")).toBe("Remote content\n\n\nBottom line");
  expect(vaultEvents.length).toBe(1);
  expect(vaultEvents[0].type).toBe("file-created");
  if (vaultEvents[0].type === "file-created") {
    expect(vaultEvents[0].path).toBe("RemoteNote.md");
  }

  // 6. Test copy, append, process, and trashLocal
  await proxied.copy("RemoteNote.md", "CopiedNote.md");
  expect(await proxied.read("CopiedNote.md")).toBe("Remote content\n\n\nBottom line");
  await proxied.append("CopiedNote.md", " + appended");
  expect(await proxied.read("CopiedNote.md")).toBe("Remote content\n\n\nBottom line + appended");
  await proxied.process("CopiedNote.md", (txt) => txt.toUpperCase());
  expect(await proxied.read("CopiedNote.md")).toBe("REMOTE CONTENT\n\n\nBOTTOM LINE + APPENDED");

  // Flush upload of CopiedNote.md and verify extra blank lines are encoded as &nbsp; for Google Drive
  await adapter.flushAllPendingUploads();
  const lastUpload = driveClient.uploadedFiles[driveClient.uploadedFiles.length - 1];
  expect(lastUpload.data).toBe("REMOTE CONTENT\n\n&nbsp;\n\nBOTTOM LINE + APPENDED");

  await proxied.trashLocal("CopiedNote.md");
  expect(await proxied.exists("CopiedNote.md")).toBe(false);
  expect(await proxied.exists(".trash/CopiedNote.md")).toBe(true);

  // 7. Test PKCE generation and mobile redirect URL code extraction
  const pkce = await generatePkcePair();
  expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(40);
  expect(pkce.codeChallenge.length).toBeGreaterThanOrEqual(40);
  expect(pkce.codeVerifier).not.toBe(pkce.codeChallenge);

  const extracted = GoogleOAuthManager.extractAuthCodeFromInput(
    "http://127.0.0.1/?state=xyz&code=4%2F0AdQt8qh12345&scope=https://www.googleapis.com/auth/drive"
  );
  expect(extracted).toBe("4/0AdQt8qh12345");
});
