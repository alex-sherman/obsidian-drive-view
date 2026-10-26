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
  const cleanConfig = normalizeVaultPath(configDir || ".obsidian");
  return clean === cleanConfig || clean.startsWith(`${cleanConfig}/`);
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

export function guessMimeType(normalizedPath: string): string {
  const lower = normalizedPath.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".canvas") || lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".base") || lower.endsWith(".yaml") || lower.endsWith(".yml")) return "text/yaml";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js")) return "application/javascript";
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
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

export function isMarkdownFilePath(normalizedPath: string): boolean {
  return normalizedPath.toLowerCase().endsWith(".md");
}

function transformOutsideCodeBlocks(
  markdown: string,
  transform: (segment: string) => string
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
    //    Replace `(?<=\n)&nbsp;\n\n` with `\n` so `\n\n&nbsp;\n\n` -> `\n\n\n` (2 blank lines).
    let out = segment.replace(/(?<=\n)[ \t]*(?:&nbsp;|\u00A0)[ \t]*\n\n/g, "\n");
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

