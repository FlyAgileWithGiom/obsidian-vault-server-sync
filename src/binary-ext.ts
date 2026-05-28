/**
 * Binary file extension helpers shared between CustomFetchSyncStrategy and
 * PouchDbFsBridge. Extracted here to avoid duplication and silent drift.
 *
 * Both strategies must agree on which files are binary so that the same
 * file is always stored via _attachments (never as a text doc).
 */

/** Constant name for the PouchDB attachment that holds binary file data. */
export const ATTACHMENT_NAME = "data.bin";

/** Extensions treated as binary — stored via CouchDB _attachments. */
export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "svgz", "ico",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "mp3", "m4a", "wav", "ogg", "flac",
  "mp4", "mov", "avi", "mkv", "webm",
  "zip", "tar", "gz", "rar", "7z",
  "bin", "heic", "drawing", "writing",
]);

/** MIME type map for common binary extensions. */
export const CONTENT_TYPE_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  svgz: "image/svg+xml",
  ico: "image/x-icon",
  heic: "image/heic",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  rar: "application/x-rar-compressed",
  "7z": "application/x-7z-compressed",
  bin: "application/octet-stream",
  drawing: "application/octet-stream",
  writing: "application/octet-stream",
};

/**
 * Returns true if the given vault file path should be treated as binary.
 * Detection is extension-based.
 */
export function isBinaryPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Returns the MIME content type for the given file path.
 * Falls back to application/octet-stream for unknown extensions.
 */
export function contentTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
}
