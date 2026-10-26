export type SyncState =
  | "disconnected"
  | "authenticating"
  | "indexing"
  | "synced"
  | "syncing"
  | "offline"
  | "error";

export interface GoogleDriveSettings {
  /**
   * OAuth 2.0 Access Token
   */
  accessToken: string;
  /**
   * OAuth 2.0 Refresh Token
   */
  refreshToken: string;
  /**
   * Expiration timestamp in ms
   */
  tokenExpiresAt: number;
  /**
   * Google Drive Folder ID acting as the root of this vault
   */
  rootFolderId: string;
  /**
   * Name of the root folder in Google Drive
   */
  rootFolderName: string;
  /**
   * Whether the Google Drive DataAdapter is actively mounted as the vault backend
   */
  adapterEnabled: boolean;
  /**
   * Debounce time (ms) before uploading local edits to Google Drive
   */
  writeDebounceMs: number;
  /**
   * Interval (seconds) for polling Google Drive changes.list
   */
  pollIntervalSec: number;
  /**
   * Whether to prefetch binary attachments to create instant blob: URLs for getResourcePath
   */
  prefetchBinaries: boolean;
  /**
   * Max file size (in MB) to prefetch automatically for blob URLs
   */
  maxPrefetchBinarySizeMB: number;
}

export const DEFAULT_SETTINGS: GoogleDriveSettings = {
  accessToken: "",
  refreshToken: "",
  tokenExpiresAt: 0,
  rootFolderId: "",
  rootFolderName: "ObsidianDriveVault",
  adapterEnabled: true,
  writeDebounceMs: 2500,
  pollIntervalSec: 30,
  prefetchBinaries: true,
  maxPrefetchBinarySizeMB: 25,
};

export interface VirtualEntry {
  /**
   * Normalized vault-relative path (e.g. "Folder/Note.md" or "Folder")
   */
  path: string;
  /**
   * Base file or folder name (e.g. "Note.md")
   */
  name: string;
  /**
   * Entry type
   */
  type: "file" | "folder";
  /**
   * Creation timestamp (ms)
   */
  ctime: number;
  /**
   * Last modification timestamp (ms)
   */
  mtime: number;
  /**
   * Byte size for files, 0 for folders
   */
  size: number;
  /**
   * Google Drive file/folder ID
   */
  driveId?: string;
  /**
   * Google Drive parent folder ID
   */
  parentId?: string;
  /**
   * MD5 checksum from Google Drive (for binary/non-Google-Doc files)
   */
  md5Checksum?: string;
  /**
   * MIME type on Google Drive
   */
  mimeType?: string;
  /**
   * Whether this entry has local modifications pending upload to Google Drive
   */
  dirty?: boolean;
  /**
   * Whether the file's full content is currently cached in IndexedDB/memory
   */
  contentCached?: boolean;
}

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  trashed?: boolean;
}

export interface DriveChangeItem {
  fileId: string;
  removed?: boolean;
  file?: DriveFileMetadata;
}
