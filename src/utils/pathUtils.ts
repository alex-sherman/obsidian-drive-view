/**
 * Pure cross-platform path and binary utilities (works on Desktop Electron and Mobile iOS/Android Capacitor).
 */

export function normalizeVaultPath(rawPath: string): string {
  if (!rawPath) return "";
  let cleaned = rawPath.replace(/\\/g, "/").trim();
  // Collapse multiple slashes
  cleaned = cleaned.replace(/\/+/g, "/");
  // Strip leading slash
  if (cleaned.startsWith("/")) {
    cleaned = cleaned.slice(1);
  }
  // Strip trailing slash
  if (cleaned.length > 1 && cleaned.endsWith("/")) {
    cleaned = cleaned.slice(0, -1);
  }
  if (cleaned === "/" || cleaned === ".") {
    return "";
  }
  return cleaned;
}

export function getParentPath(normalizedPath: string): string {
  const clean = normalizeVaultPath(normalizedPath);
  const idx = clean.lastIndexOf("/");
  if (idx === -1) return "";
  return clean.slice(0, idx);
}

export function getBaseName(normalizedPath: string): string {
  const clean = normalizeVaultPath(normalizedPath);
  const idx = clean.lastIndexOf("/");
  if (idx === -1) return clean;
  return clean.slice(idx + 1);
}

export function isConfigOrInternalPath(normalizedPath: string, configDir: string): boolean {
  const clean = normalizeVaultPath(normalizedPath);
  const cleanConfig = normalizeVaultPath(configDir);
  return clean === cleanConfig || clean.startsWith(`${cleanConfig}/`);
}

/**
 * Returns true if `normalizedPath` is inside `configDir` AND is safe to sync across devices.
 * Excludes volatile workspace files (`workspace.json`, `workspace-mobile.json`) and this plugin's own directory
 * so OAuth tokens and symlinked dev builds are never overwritten.
 */
export function isSyncableConfigPath(
  normalizedPath: string,
  configDir: string,
  selfPluginIds: string[] = ["drive-view", "obsidian-drive-view", "obsidian-drive-sync"],
): boolean {
  const clean = normalizeVaultPath(normalizedPath);
  const cleanConfig = normalizeVaultPath(configDir);
  if (!isConfigOrInternalPath(clean, cleanConfig)) {
    return false;
  }
  if (clean === cleanConfig) {
    return true;
  }

  const relPath = clean.slice(cleanConfig.length + 1);
  if (
    relPath === "workspace.json" ||
    relPath === "workspace-mobile.json" ||
    relPath === "workspace" ||
    relPath === "graph.json"
  ) {
    return false;
  }

  const baseName = getBaseName(relPath);
  if (baseName === ".DS_Store" || baseName === "Thumbs.db" || baseName === ".git") {
    return false;
  }

  if (
    selfPluginIds.some((id) => relPath === `plugins/${id}` || relPath.startsWith(`plugins/${id}/`))
  ) {
    return false;
  }

  return true;
}

export function isTextFilePath(normalizedPath: string): boolean {
  const lower = normalizedPath.toLowerCase();
  const textExtensions = [
    ".md",
    ".txt",
    ".canvas",
    ".base",
    ".json",
    ".css",
    ".js",
    ".ts",
    ".csv",
    ".yaml",
    ".yml",
    ".xml",
    ".html",
    ".svg",
    ".org",
    ".tex",
  ];
  return textExtensions.some((ext) => lower.endsWith(ext));
}

const mimeTypes: { [key: string]: string } = {
  md: "text/markdown",
  txt: "text/plain",
  canvas: "application/json",
  json: "application/json",
  base: "text/yaml",
  yaml: "text/yaml",
  yml: "text/yaml",
  css: "text/css",
  js: "application/javascript",
  ts: "application/typescript",
  html: "text/html",
  csv: "text/csv",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function guessMimeType(normalizedPath: string): string {
  const lower = normalizedPath.toLowerCase();
  const extension = lower.split(".").at(-1)?.toLowerCase();
  if (extension && mimeTypes[extension]) {
    return mimeTypes[extension];
  }
  return "application/octet-stream";
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

export function stringToArrayBuffer(str: string): ArrayBuffer {
  const uint8 = textEncoder.encode(str);
  return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
}

export function arrayBufferToString(buffer: ArrayBuffer): string {
  return textDecoder.decode(buffer);
}

export function concatArrayBuffers(a: ArrayBuffer, b: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out.buffer;
}

export function arrayBuffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const viewA = new Uint8Array(a);
  const viewB = new Uint8Array(b);
  for (let i = 0; i < viewA.length; i++) {
    if (viewA[i] !== viewB[i]) return false;
  }
  return true;
}

export function isMarkdownFilePath(normalizedPath: string): boolean {
  return normalizedPath.toLowerCase().endsWith(".md");
}

function transformOutsideCodeBlocks(
  markdown: string,
  transform: (segment: string) => string,
): string {
  // Match fenced code blocks (```...``` or ~~~...~~~) so we never alter code block contents
  const codeBlockRegex = /^(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^(?:`{3,}|~{3,})[ \t]*$/gm;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      result += transform(markdown.slice(lastIndex, match.index));
    }
    result += match[0];
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < markdown.length) {
    result += transform(markdown.slice(lastIndex));
  }

  return result;
}

/**
 * Converts Markdown downloaded from Google Drive into clean Obsidian Markdown:
 * - Normalizes CRLF to LF.
 * - Converts Google Docs' empty-paragraph `&nbsp;` markers (`\n\n&nbsp;\n\n`) into clean blank lines
 *   (`\n\n\n`) so literal `&nbsp;` never appears in Obsidian notes.
 */
export function driveMarkdownToObsidian(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  return transformOutsideCodeBlocks(normalized, (segment) => {
    // 1. In Google Docs Markdown exports, each empty paragraph is `\n\n&nbsp;\n\n`.
    //    Replace `(\n)&nbsp;\n\n` with `$1\n` so `\n\n&nbsp;\n\n` -> `\n\n\n` (without regex lookbehind for iOS < 16.4).
    let out = segment.replace(/(^|\n)[ \t]*(?:&nbsp;|\u00A0)[ \t]*\n\n/g, "$1\n");
    // 2. Replace any remaining standalone `&nbsp;` lines (e.g. `Line1\n&nbsp;\nLine2` or EOF) with empty line
    out = out.replace(/^[ \t]*(?:&nbsp;|\u00A0)[ \t]*$/gm, "");
    return out;
  });
}

/**
 * Converts Obsidian Markdown into Google Drive / Google Docs compatible Markdown before upload:
 * - Cleans any existing standalone `&nbsp;` lines first so they never double-encode.
 * - Encodes extra blank lines (`\n{3,}`) as `\n\n&nbsp;\n\n` blocks so Google Docs preserves
 *   empty lines added in Obsidian instead of collapsing them.
 */
export function obsidianMarkdownToDrive(text: string): string {
  const cleanObsidian = driveMarkdownToObsidian(text);
  return transformOutsideCodeBlocks(cleanObsidian, (segment) => {
    return segment.replace(/\n{3,}/g, (match) => {
      const emptyParagraphCount = match.length - 2;
      const nbspBlocks = Array.from({ length: emptyParagraphCount }, () => "&nbsp;").join("\n\n");
      return `\n\n${nbspBlocks}\n\n`;
    });
  });
}
