const DOC_PREFIX = "file/";

const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "text", "json", "yaml", "yml", "xml",
  "html", "htm", "css", "js", "ts", "csv", "svg", "toml", "ini",
  "cfg", "conf", "sh", "bash", "zsh", "py", "rb", "rs", "go",
  "java", "kt", "c", "cpp", "h", "hpp", "lua", "r", "sql",
  "graphql", "tex", "bib", "org", "rst", "adoc", "log",
]);

const EXCLUDED_PREFIXES = [".obsidian/", ".trash/"];

const MIME_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", mp3: "audio/mpeg", mp4: "video/mp4",
  webm: "video/webm",
};

export function encodeDocId(path: string): string {
  return DOC_PREFIX + encodeURIComponent(path).replace(/%2F/g, "/");
}

export function decodeDocId(id: string): string {
  return decodeURIComponent(id.slice(DOC_PREFIX.length));
}

export function isDocId(id: string): boolean {
  return id.startsWith(DOC_PREFIX);
}

export function isTextFile(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext.toLowerCase());
}

export function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function getMimeType(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}
