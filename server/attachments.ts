import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import type { MessageOptions } from "@factory/droid-sdk/node";
import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";

const MIB = 1024 * 1024;
export const ATTACHMENT_LIMITS = {
  imageBytes: 10 * MIB,
  pdfBytes: 16 * MIB,
  textBytes: 2 * MIB,
  localReferenceBytes: 256 * MIB,
  totalBytes: 16 * MIB,
  count: 20,
} as const;

type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
type NativeInputs = Pick<MessageOptions, "images" | "files">;
type Upload = Extract<ProviderContent, { type: "uploaded_file" }>;

export interface PreparedPrompt {
  /** Human text and ordered references to native image/document inputs. */
  text: string;
  /** Safe user-row text; binary data and large document bodies stay out of persistence. */
  timelineText: string;
  options: NativeInputs;
}

export interface PreparePromptOptions {
  cwd?: string;
  signal?: AbortSignal;
}

const imageMimes = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const imageExtensions: Record<string, ImageMime> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const textMimes = new Set([
  "application/json", "application/ld+json", "application/jsonl", "application/x-ndjson", "application/xml",
  "application/yaml", "application/x-yaml", "application/javascript", "application/typescript",
  "application/x-sh", "application/x-httpd-php", "application/toml", "application/sql", "inode/x-empty",
]);
const textExtensions = new Set([
  ".txt", ".md", ".mdx", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml",
  ".xml", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".svg", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".pyi", ".rb", ".rs", ".go", ".java", ".kt", ".kts", ".swift", ".m", ".mm", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".cs", ".fs", ".php", ".vue", ".svelte", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".sql", ".graphql",
  ".gql", ".proto", ".ini", ".cfg", ".conf", ".config", ".env", ".properties", ".gradle", ".log", ".diff", ".patch", ".tex",
]);

function mime(value: string): string { return value.split(";", 1)[0].trim().toLowerCase(); }
function name(value: string): string {
  return basename(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240) || "attachment";
}
function error(label: string, message: string): Error { return new Error(`Attachment ${JSON.stringify(label)}: ${message}`); }
function checkSize(size: number, max: number, label: string): void {
  if (!Number.isSafeInteger(size) || size < 0) throw error(label, "invalid file size.");
  if (size > max) throw error(label, `exceeds the ${max / MIB} MiB limit.`);
}

function imageSignature(bytes: Buffer, mediaType: ImageMime, label: string): void {
  const valid = mediaType === "image/png"
    ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR"
    : mediaType === "image/jpeg"
      ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mediaType === "image/gif"
        ? bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
        : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw error(label, `file content does not match ${mediaType}.`);
}

function decodeImage(data: string, mediaType: ImageMime, label: string): Buffer {
  if (data.length > Math.ceil(ATTACHMENT_LIMITS.imageBytes / 3) * 4 + 2048)
    throw error(label, "exceeds the 10 MiB image limit.");
  let encoded = data;
  if (encoded.startsWith("data:")) {
    const source = /^data:([^;,]+);base64,([\s\S]*)$/.exec(encoded);
    if (!source || mime(source[1]) !== mediaType) throw error(label, "invalid image data URI.");
    encoded = source[2];
  }
  encoded = encoded.replace(/\s/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1 || (encoded.includes("=") && encoded.length % 4 !== 0))
    throw error(label, "invalid base64 image data.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, ""))
    throw error(label, "invalid base64 image data.");
  checkSize(bytes.length, ATTACHMENT_LIMITS.imageBytes, label);
  imageSignature(bytes, mediaType, label);
  return bytes;
}

function textData(bytes: Buffer, label: string): string {
  checkSize(bytes.length, ATTACHMENT_LIMITS.textBytes, label);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw error(label, "text files must use UTF-8 encoding."); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text))
    throw error(label, "binary content cannot be sent as text.");
  return text;
}

function uploadKind(upload: Upload): ImageMime | "application/pdf" | "text/plain" | "reference" {
  const declared = mime(upload.mimeType);
  if (declared && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(declared))
    throw error(name(upload.fileName), "invalid MIME type.");
  if (imageMimes.has(declared)) return declared as ImageMime;
  if (declared === "application/pdf") return declared;
  if (declared.startsWith("text/") || textMimes.has(declared)) return "text/plain";
  // Some upload clients provide a generic MIME even for known file extensions.
  // Content signatures/UTF-8 decoding still have to agree with this fallback.
  if (!declared || declared === "application/octet-stream") {
    const extension = extname(upload.fileName).toLowerCase();
    if (imageExtensions[extension]) return imageExtensions[extension];
    if (extension === ".pdf") return "application/pdf";
    if (textExtensions.has(extension) || /^(?:readme|license|copying|notice|dockerfile|makefile|gemfile|rakefile)(?:\..*)?$/i.test(basename(upload.fileName)))
      return "text/plain";
  }
  return "reference";
}

async function openUpload(upload: Upload, max: number, options: PreparePromptOptions) {
  const label = name(upload.fileName);
  checkSize(upload.size, max, label);
  if (!upload.path || upload.path.includes("\0")) throw error(label, "invalid file path.");
  if (!isAbsolute(upload.path) && !options.cwd) throw error(label, "a relative file path requires the session working directory.");
  const candidate = isAbsolute(upload.path) ? upload.path : resolve(options.cwd!, upload.path);
  options.signal?.throwIfAborted();
  let filePath: string;
  let handle;
  try {
    filePath = await realpath(candidate);
    handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  }
  catch { throw error(label, "cannot read the uploaded file; upload it again."); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw error(label, "the upload path must identify a regular file.");
    checkSize(stat.size, max, label);
    if (stat.size !== upload.size) throw error(label, "file size changed; upload it again.");
    return { handle, size: stat.size, filePath };
  } catch (failure) { await handle.close(); throw failure; }
}

async function readUpload(upload: Upload, max: number, options: PreparePromptOptions): Promise<Buffer> {
  const label = name(upload.fileName);
  const { handle, size } = await openUpload(upload, max, options);
  try {
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    options.signal?.throwIfAborted();
    if (offset !== size) throw error(label, "file size changed while reading; upload it again.");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function localReference(upload: Upload, options: PreparePromptOptions): Promise<string> {
  const label = name(upload.fileName);
  const { handle, size, filePath } = await openUpload(upload, ATTACHMENT_LIMITS.localReferenceBytes, options);
  try {
    const header = Buffer.alloc(Math.min(512, size));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    const declared = mime(upload.mimeType);
    const extension = extname(upload.fileName).toLowerCase();
    const zip = declared === "application/zip" || declared === "application/x-zip-compressed" || declared.includes("officedocument") || declared.includes("macroenabled") || [".zip", ".docx", ".xlsx", ".pptx", ".docm", ".xlsm", ".pptm", ".odt", ".ods", ".odp", ".epub", ".jar"].includes(extension);
    const ole = ["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(declared) || [".doc", ".xls", ".ppt"].includes(extension);
    const gzip = declared === "application/gzip" || declared === "application/x-gzip" || extension === ".gz";
    if ((zip && !(bytes[0] === 0x50 && bytes[1] === 0x4b && [[3, 4], [5, 6], [7, 8]].some(([a, b]) => bytes[2] === a && bytes[3] === b))) ||
      (ole && !bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) ||
      (gzip && !(bytes[0] === 0x1f && bytes[1] === 0x8b)))
      throw error(label, "file content does not match its declared format.");
    options.signal?.throwIfAborted();
    return [
      `MIME type: ${declared || "application/octet-stream"}`,
      `Size: ${size} bytes`,
      `Verified local path: ${JSON.stringify(filePath)}`,
      "This is a local file reference. Its contents have not been decoded or attached as a native image/document; use suitable tools to inspect it if needed.",
    ].join("\n");
  } finally { await handle.close(); }
}

function structured(content: Exclude<ProviderContent, { type: "text" | "image" | "uploaded_file" }>): { label: string; text: string } {
  if (content.type === "review") {
    const text = [
      `Review working directory: ${content.cwd}`,
      `Review mode: ${content.mode}`,
      ...(content.baseRef ? [`Base ref: ${content.baseRef}`] : []),
      ...content.comments.flatMap((comment, index) => [
        `\nComment ${index + 1}: ${comment.filePath} (${comment.side} line ${comment.lineNumber})`,
        comment.body,
        `Context: ${comment.context.hunkHeader}`,
        ...comment.context.lines.map((line) => `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "} [old ${line.oldLineNumber ?? "-"}, new ${line.newLineNumber ?? "-"}] ${line.content}`),
        `Target line: ${comment.context.targetLine.content}`,
      ]),
    ].join("\n");
    return { label: "Code review", text };
  }
  if (!["forge_change_request", "forge_issue", "github_pr", "github_issue"].includes(content.type))
    throw new Error("Droid received an unsupported attachment type.");
  const change = content.type === "forge_change_request" || content.type === "github_pr";
  return {
    label: `${change ? "Change request" : "Issue"} #${content.number}: ${content.title}`,
    text: [
      `${change ? "Change request" : "Issue"} #${content.number}: ${content.title}`,
      `URL: ${content.url}`,
      ...("forge" in content && content.forge ? [`Forge: ${content.forge}`] : []),
      ...("projectPath" in content && content.projectPath ? [`Project: ${content.projectPath}`] : []),
      ...("baseRefName" in content && content.baseRefName ? [`Base ref: ${content.baseRefName}`] : []),
      ...("headRefName" in content && content.headRefName ? [`Head ref: ${content.headRefName}`] : []),
      ...(content.body ? ["Body:", content.body] : []),
    ].join("\n"),
  };
}

/** Convert every current Paseo message content variant to SDK-native inputs. */
export async function preparePrompt(prompt: ProviderPrompt, options: PreparePromptOptions = {}): Promise<PreparedPrompt> {
  if (prompt.input.type !== "message") throw new Error("Droid accepts message prompts; command prompts are not supported.");
  const parts: string[] = [];
  const timeline: string[] = [];
  const images: NonNullable<MessageOptions["images"]> = [];
  const files: NonNullable<MessageOptions["files"]> = [];
  let attachmentCount = 0;
  let totalBytes = 0;
  let textBytes = 0;
  function addBytes(bytes: number, label: string) {
    totalBytes += bytes;
    if (totalBytes > ATTACHMENT_LIMITS.totalBytes) throw error(label, "combined attachments exceed the 16 MiB limit.");
  }
  function marker(label: string, extra: string): string {
    return `[Attachment ${attachmentCount}: ${name(label)}; ${extra}]`;
  }
  for (const content of prompt.input.content) {
    options.signal?.throwIfAborted();
    if (content.type === "text" && !("mimeType" in content)) {
      textBytes += Buffer.byteLength(content.text);
      checkSize(textBytes, ATTACHMENT_LIMITS.textBytes, "message text");
      parts.push(content.text);
      timeline.push(content.text);
      continue;
    }
    attachmentCount++;
    if (attachmentCount > ATTACHMENT_LIMITS.count) throw new Error("Droid accepts at most 20 attachments per message.");
    if (content.type === "image") {
      const mediaType = mime(content.mimeType);
      if (!imageMimes.has(mediaType)) throw error(`image ${images.length + 1}`, "supported image formats are PNG, JPEG, GIF, and WebP.");
      const bytes = decodeImage(content.data, mediaType as ImageMime, `image ${images.length + 1}`);
      addBytes(bytes.length, "inline image");
      images.push({ type: "base64", mediaType: mediaType as ImageMime, data: bytes.toString("base64") });
      const reference = marker(`image ${images.length}`, `${mediaType}; native image ${images.length}`);
      parts.push(reference);
      timeline.push(reference);
    } else if (content.type === "uploaded_file") {
      const label = name(content.fileName);
      const kind = uploadKind(content);
      if (kind === "reference") {
        const reference = marker(label, "local file reference");
        const metadata = await localReference(content, options);
        addBytes(Buffer.byteLength(metadata), label);
        parts.push(`${reference}\n${metadata}`);
        timeline.push(reference);
        continue;
      }
      const max = imageMimes.has(kind) ? ATTACHMENT_LIMITS.imageBytes : kind === "application/pdf" ? ATTACHMENT_LIMITS.pdfBytes : ATTACHMENT_LIMITS.textBytes;
      const bytes = await readUpload(content, max, options);
      addBytes(bytes.length, label);
      let reference: string;
      if (imageMimes.has(kind)) {
        imageSignature(bytes, kind as ImageMime, label);
        images.push({ type: "base64", mediaType: kind as ImageMime, data: bytes.toString("base64") });
        reference = marker(label, `${kind}; native image ${images.length}`);
      } else {
        if (kind === "application/pdf") {
          if (bytes.toString("ascii", 0, 5) !== "%PDF-" || !bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from("%%EOF")))
            throw error(label, "file content does not match application/pdf.");
          files.push({ type: "base64", mediaType: "application/pdf", data: bytes.toString("base64"), name: label });
        } else {
          files.push({ type: "text", mediaType: "text/plain", data: textData(bytes, label), name: label });
        }
        reference = marker(label, `${kind}; native document ${files.length}`);
      }
      parts.push(reference);
      timeline.push(reference);
    } else if (content.type === "text") {
      const label = name(content.title ?? `context ${attachmentCount}.txt`);
      const bytes = Buffer.from(content.text);
      addBytes(bytes.length, label);
      const data = textData(bytes, label);
      files.push({ type: "text", mediaType: "text/plain", data, name: label });
      const reference = marker(label, `text/plain; native document ${files.length}`);
      const metadata = [
        ...(content.contextKind ? [`Context kind: ${content.contextKind}`] : []),
        ...(content.externalResource ? [
          `Resource: ${content.externalResource.providerLabel} / ${content.externalResource.resourceType} / ${content.externalResource.identifier}`,
          `Resource title: ${content.externalResource.title}`,
          `Resource URL: ${content.externalResource.url}`,
        ] : []),
      ];
      parts.push([reference, ...metadata].join("\n"));
      timeline.push(reference);
    } else {
      const rendered = structured(content);
      const bytes = Buffer.byteLength(rendered.text);
      checkSize(bytes, ATTACHMENT_LIMITS.textBytes, name(rendered.label));
      addBytes(bytes, name(rendered.label));
      const reference = marker(rendered.label, content.type);
      parts.push(`${reference}\n${rendered.text}`);
      timeline.push(reference);
    }
  }
  if (!parts.length) throw new Error("A Droid message must contain text or an attachment.");
  options.signal?.throwIfAborted();
  return {
    text: parts.join("\n\n"),
    timelineText: timeline.join("\n\n"),
    options: { ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) },
  };
}
