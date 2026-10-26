import { requestUrl, RequestUrlParam } from "obsidian";
import { DriveChangeItem, DriveFileMetadata, VirtualEntry } from "../types";
import { concatArrayBuffers, normalizeVaultPath, stringToArrayBuffer } from "../utils/pathUtils";
import { GoogleOAuthManager } from "../auth/GoogleOAuth";

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,mimeType,parents,createdTime,modifiedTime,size,md5Checksum,trashed";

export class DriveClient {
  constructor(private auth: GoogleOAuthManager) {}

  private async authorizedRequest(params: Omit<RequestUrlParam, "headers"> & { headers?: Record<string, string> }) {
    const token = await this.auth.getValidAccessToken();
    const response = await requestUrl({
      ...params,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(params.headers || {}),
      },
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(`Google Drive API error (${response.status}): ${response.text}`);
    }

    return response;
  }

  /**
   * Verifies an existing root folder ID or finds/creates a root folder by name in My Drive.
   */
  public async ensureRootFolder(folderName: string, existingFolderId?: string): Promise<DriveFileMetadata> {
    if (existingFolderId && existingFolderId.trim()) {
      try {
        const res = await this.authorizedRequest({
          url: `${DRIVE_API_BASE}/files/${encodeURIComponent(existingFolderId.trim())}?fields=${FILE_FIELDS}`,
          method: "GET",
        });
        const meta = res.json as DriveFileMetadata;
        if (meta && meta.id && !meta.trashed && meta.mimeType === DRIVE_FOLDER_MIME) {
          return meta;
        }
      } catch {
        // Fall through to search/create by name
      }
    }

    const escapedName = folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = `mimeType = '${DRIVE_FOLDER_MIME}' and name = '${escapedName}' and 'root' in parents and trashed = false`;
    const searchUrl = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(${FILE_FIELDS})&pageSize=10`;
    const searchRes = await this.authorizedRequest({ url: searchUrl, method: "GET" });
    const files = (searchRes.json?.files || []) as DriveFileMetadata[];

    if (files.length > 0) {
      return files[0];
    }

    return this.createFolder(folderName, "root");
  }

  /**
   * Lists direct child folders of a parent folder ID (defaults to "root"), ordered alphabetically.
   */
  public async listFolders(parentId = "root"): Promise<DriveFileMetadata[]> {
    const q = `mimeType = '${DRIVE_FOLDER_MIME}' and '${parentId}' in parents and trashed = false`;
    const params = new URLSearchParams({
      q,
      fields: `files(${FILE_FIELDS})`,
      pageSize: "200",
      orderBy: "name",
      spaces: "drive",
    });

    const res = await this.authorizedRequest({
      url: `${DRIVE_API_BASE}/files?${params.toString()}`,
      method: "GET",
    });

    return (res.json?.files || []) as DriveFileMetadata[];
  }

  /**
   * Lists direct children of one or more parent folder IDs.
   */
  public async listChildrenForParents(parentIds: string[]): Promise<DriveFileMetadata[]> {
    if (parentIds.length === 0) return [];
    const results: DriveFileMetadata[] = [];

    // Chunk parentIds in batches of 25 so the query string stays well within Drive API limits
    const chunkSize = 25;
    for (let i = 0; i < parentIds.length; i += chunkSize) {
      const batch = parentIds.slice(i, i + chunkSize);
      const parentClause = batch.map((id) => `'${id}' in parents`).join(" or ");
      const q = `(${parentClause}) and trashed = false`;

      let pageToken: string | undefined = undefined;
      do {
        const params = new URLSearchParams({
          q,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: "1000",
          spaces: "drive",
        });
        if (pageToken) params.set("pageToken", pageToken);

        const res = await this.authorizedRequest({
          url: `${DRIVE_API_BASE}/files?${params.toString()}`,
          method: "GET",
        });

        const data = res.json as { files?: DriveFileMetadata[]; nextPageToken?: string };
        if (data.files) {
          results.push(...data.files);
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
    }

    return results;
  }

  /**
   * Recursively fetches the entire vault tree under `rootFolderId` using breadth-first level queries.
   */
  public async fetchFullVaultTree(rootFolderId: string): Promise<VirtualEntry[]> {
    const entries: VirtualEntry[] = [];
    const folderIdToPath = new Map<string, string>();
    folderIdToPath.set(rootFolderId, "");

    let currentLevelFolderIds = [rootFolderId];

    while (currentLevelFolderIds.length > 0) {
      const children = await this.listChildrenForParents(currentLevelFolderIds);
      const nextLevelFolderIds: string[] = [];

      for (const item of children) {
        // Skip Google Docs native formats that don't have binary/file content unless folder
        if (
          item.mimeType.startsWith("application/vnd.google-apps.") &&
          item.mimeType !== DRIVE_FOLDER_MIME
        ) {
          continue;
        }

        const parentId = item.parents?.find((pid) => folderIdToPath.has(pid));
        if (!parentId) continue;

        const parentPath = folderIdToPath.get(parentId) || "";
        const entryPath = normalizeVaultPath(parentPath ? `${parentPath}/${item.name}` : item.name);
        const ctime = item.createdTime ? Date.parse(item.createdTime) : Date.now();
        const mtime = item.modifiedTime ? Date.parse(item.modifiedTime) : ctime;
        const isFolder = item.mimeType === DRIVE_FOLDER_MIME;

        const entry: VirtualEntry = {
          path: entryPath,
          name: item.name,
          type: isFolder ? "folder" : "file",
          ctime,
          mtime,
          size: isFolder ? 0 : Number(item.size || 0),
          driveId: item.id,
          parentId,
          md5Checksum: item.md5Checksum,
          mimeType: item.mimeType,
          dirty: false,
          contentCached: false,
        };

        entries.push(entry);

        if (isFolder) {
          folderIdToPath.set(item.id, entryPath);
          nextLevelFolderIds.push(item.id);
        }
      }

      currentLevelFolderIds = nextLevelFolderIds;
    }

    return entries;
  }

  public async downloadText(fileId: string): Promise<string> {
    const res = await this.authorizedRequest({
      url: `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
      method: "GET",
    });
    return res.text;
  }

  public async downloadBinary(fileId: string): Promise<ArrayBuffer> {
    const res = await this.authorizedRequest({
      url: `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
      method: "GET",
    });
    return res.arrayBuffer;
  }

  public async createFolder(name: string, parentId: string): Promise<DriveFileMetadata> {
    const metadata = {
      name,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [parentId],
    };

    const res = await this.authorizedRequest({
      url: `${DRIVE_API_BASE}/files?fields=${FILE_FIELDS}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(metadata),
    });

    return res.json as DriveFileMetadata;
  }

  /**
   * Creates or updates a file on Google Drive using multipart/related upload so metadata + binary/text
   * content are uploaded in a single atomic request.
   */
  public async uploadFile(options: {
    fileId?: string;
    name: string;
    parentId: string;
    data: ArrayBuffer | string;
    mimeType: string;
    mtime?: number;
  }): Promise<DriveFileMetadata> {
    const boundary = `-------ObsidianDriveBoundary${Date.now().toString(16)}`;
    const metadata: Record<string, unknown> = {
      name: options.name,
      mimeType: options.mimeType,
    };

    if (!options.fileId) {
      metadata.parents = [options.parentId];
    }
    if (options.mtime) {
      metadata.modifiedTime = new Date(options.mtime).toISOString();
    }

    const contentBuffer =
      typeof options.data === "string" ? stringToArrayBuffer(options.data) : options.data;

    const preamble = stringToArrayBuffer(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${options.mimeType}\r\n\r\n`
    );
    const epilogue = stringToArrayBuffer(`\r\n--${boundary}--`);

    const multipartBody = concatArrayBuffers(concatArrayBuffers(preamble, contentBuffer), epilogue);

    const isUpdate = Boolean(options.fileId);
    const url = isUpdate
      ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(options.fileId!)}?uploadType=multipart&fields=${FILE_FIELDS}`
      : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=${FILE_FIELDS}`;

    const res = await this.authorizedRequest({
      url,
      method: isUpdate ? "PATCH" : "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    return res.json as DriveFileMetadata;
  }

  public async moveOrRename(
    fileId: string,
    newName: string,
    oldParentId?: string,
    newParentId?: string
  ): Promise<DriveFileMetadata> {
    const params = new URLSearchParams({ fields: FILE_FIELDS });
    if (newParentId && oldParentId && newParentId !== oldParentId) {
      params.set("addParents", newParentId);
      params.set("removeParents", oldParentId);
    }

    const res = await this.authorizedRequest({
      url: `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ name: newName }),
    });

    return res.json as DriveFileMetadata;
  }

  public async copyFile(
    fileId: string,
    newName: string,
    parentId: string
  ): Promise<DriveFileMetadata> {
    const res = await this.authorizedRequest({
      url: `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/copy?fields=${FILE_FIELDS}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        name: newName,
        parents: [parentId],
      }),
    });

    return res.json as DriveFileMetadata;
  }

  public async trashFile(fileId: string): Promise<void> {
    await this.authorizedRequest({
      url: `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ trashed: true }),
    });
  }

  public async deleteFile(fileId: string): Promise<void> {
    await this.authorizedRequest({
      url: `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
      method: "DELETE",
    });
  }

  public async getStartPageToken(): Promise<string> {
    const res = await this.authorizedRequest({
      url: `${DRIVE_API_BASE}/changes/startPageToken`,
      method: "GET",
    });
    return res.json.startPageToken as string;
  }

  public async listChanges(pageToken: string): Promise<{
    changes: DriveChangeItem[];
    newStartPageToken: string;
  }> {
    const changes: DriveChangeItem[] = [];
    let currentToken: string | undefined = pageToken;
    let newStartPageToken = pageToken;

    while (currentToken) {
      const params = new URLSearchParams({
        pageToken: currentToken,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
        pageSize: "500",
        includeRemoved: "true",
      });

      const res = await this.authorizedRequest({
        url: `${DRIVE_API_BASE}/changes?${params.toString()}`,
        method: "GET",
      });

      const data = res.json as {
        changes?: DriveChangeItem[];
        nextPageToken?: string;
        newStartPageToken?: string;
      };

      if (data.changes) {
        changes.push(...data.changes);
      }
      if (data.newStartPageToken) {
        newStartPageToken = data.newStartPageToken;
      }
      currentToken = data.nextPageToken;
    }

    return { changes, newStartPageToken };
  }
}
