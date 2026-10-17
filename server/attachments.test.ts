import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { ATTACHMENT_LIMITS, preparePrompt } from "./attachments";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5nQAAAAASUVORK5CYII=", "base64");
const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const message = (...content: ProviderContent[]): ProviderPrompt => ({
  clientMessageId: "attachments-test", delivery: "auto", input: { type: "message", content },
});
const image = (data = png.toString("base64"), mimeType = "image/png"): ProviderContent => ({ type: "image", data, mimeType });

async function uploads() {
  const directory = await mkdtemp(join(tmpdir(), "droid-attachments-"));
  async function file(fileName: string, mimeType: string, bytes: Buffer | string): Promise<Extract<ProviderContent, { type: "uploaded_file" }>> {
    const path = join(directory, fileName);
    await writeFile(path, bytes);
    return { type: "uploaded_file", id: fileName, fileName, mimeType, path, size: (await stat(path)).size };
  }
  return { directory, file, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("mixed content retains ordered references and sends binary/documents through native SDK options", async () => {
  const u = await uploads();
  try {
    const doc = await u.file("brief.pdf", "application/pdf", pdf);
    const code = await u.file("main.ts", "application/octet-stream", "export const greeting = '\u4f60\u597d';\n");
    const prepared = await preparePrompt(message(
      { type: "text", text: "First compare the image" }, image(),
      { type: "text", text: "then the PDF" }, doc,
      { type: "text", text: "and this source file" }, code,
    ));
    assert.ok(prepared.text.indexOf("First compare") < prepared.text.indexOf("native image 1"));
    assert.ok(prepared.text.indexOf("native image 1") < prepared.text.indexOf("then the PDF"));
    assert.ok(prepared.text.indexOf("then the PDF") < prepared.text.indexOf("brief.pdf"));
    assert.ok(prepared.text.indexOf("brief.pdf") < prepared.text.indexOf("main.ts"));
    assert.deepEqual(prepared.options.images, [{ type: "base64", mediaType: "image/png", data: png.toString("base64") }]);
    assert.deepEqual(prepared.options.files, [
      { type: "base64", mediaType: "application/pdf", data: pdf.toString("base64"), name: "brief.pdf" },
      { type: "text", mediaType: "text/plain", data: "export const greeting = '\u4f60\u597d';\n", name: "main.ts" },
    ]);
    assert.doesNotMatch(prepared.timelineText, /iVBOR|JVBER|export const/);
    assert.equal(prepared.timelineText, prepared.text);
  } finally { await u.cleanup(); }
});

test("inline images normalize valid data URIs and retain each supported native media type", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00", "binary");
  const webp = Buffer.from("RIFF\x04\x00\x00\x00WEBP", "binary");
  const prepared = await preparePrompt(message(
    image(`data:image/png;base64,${png.toString("base64")}`),
    image(jpeg.toString("base64"), "image/jpeg"),
    image(gif.toString("base64"), "image/gif"),
    image(webp.toString("base64"), "image/webp"),
  ));
  assert.deepEqual(prepared.options.images?.map(({ mediaType }) => mediaType), ["image/png", "image/jpeg", "image/gif", "image/webp"]);
  assert.equal(prepared.options.images?.[0].data, png.toString("base64"));
  assert.match(prepared.text, /Attachment 4: image 4/);
});

test("invalid base64, image MIME mismatches, unsupported image formats, and empty payloads are rejected", async () => {
  for (const content of [
    image("%%%not-base64%%%"), image("AAAA=AAA"), image("A"), image(""),
    image(png.toString("base64"), "image/jpeg"),
    image(`data:image/jpeg;base64,${png.toString("base64")}`),
    image(png.toString("base64"), "image/svg+xml"),
  ]) await assert.rejects(preparePrompt(message(content)), /Attachment/);
});

test("uploaded images, PDFs, Unicode text and relative paths are read as bounded native inputs", async () => {
  const u = await uploads();
  try {
    const picture = await u.file("diagram.png", "image/png", png);
    const markdown = await u.file("readme.md", "text/markdown; charset=utf-8", "# \u8aaa\u660e\nCantonese text\n");
    const prepared = await preparePrompt(message(picture, { ...markdown, path: "readme.md" }), { cwd: u.directory });
    assert.equal(prepared.options.images?.[0].data, png.toString("base64"));
    assert.equal(prepared.options.files?.[0].data, "# \u8aaa\u660e\nCantonese text\n");
    assert.match(prepared.timelineText, /diagram\.png/);
    assert.match(prepared.timelineText, /readme\.md/);
    assert.doesNotMatch(prepared.timelineText, /Cantonese text/);
    await assert.rejects(preparePrompt(message({ ...markdown, path: "readme.md" })), /working directory/);
  } finally { await u.cleanup(); }
});

test("uploaded metadata, regular-file paths, MIME signatures and UTF-8 text are validated", async () => {
  const u = await uploads();
  try {
    const good = await u.file("good.txt", "text/plain", "hello");
    await assert.rejects(preparePrompt(message({ ...good, size: good.size + 1 })), /size changed/);
    await assert.rejects(preparePrompt(message({ ...good, size: -1 })), /invalid file size/);
    await assert.rejects(preparePrompt(message({ ...good, path: join(u.directory, "missing.txt") })), /cannot read/);
    const directory = join(u.directory, "folder.txt");
    await mkdir(directory);
    await assert.rejects(preparePrompt(message({ ...good, path: directory })), /regular file/);
    const badPng = await u.file("fake.png", "image/png", "not a PNG");
    await assert.rejects(preparePrompt(message(badPng)), /does not match image\/png/);
    const badPdf = await u.file("fake.pdf", "application/pdf", "not a PDF");
    await assert.rejects(preparePrompt(message(badPdf)), /does not match application\/pdf/);
    const noEndPdf = await u.file("truncated.pdf", "application/pdf", "%PDF-1.7\ntruncated");
    await assert.rejects(preparePrompt(message(noEndPdf)), /does not match application\/pdf/);
    const utf16 = await u.file("utf16.txt", "text/plain", Buffer.from([0xff, 0xfe, 0x68, 0x00]));
    await assert.rejects(preparePrompt(message(utf16)), /UTF-8/);
    const binary = await u.file("binary.txt", "text/plain", Buffer.from([0x68, 0x00, 0x69]));
    await assert.rejects(preparePrompt(message(binary)), /binary content/);
    const zip = await u.file("archive.zip", "application/zip", "PK archive");
    await assert.rejects(preparePrompt(message(zip)), /does not match its declared format/);
  } finally { await u.cleanup(); }
});

test("Office, archives and other binaries attach as verified local references without embedding their body", async () => {
  const u = await uploads();
  try {
    const emptyZip = Buffer.alloc(22);
    Buffer.from([0x50, 0x4b, 0x05, 0x06]).copy(emptyZip);
    const archive = await u.file("bundle.zip", "application/zip", emptyZip);
    const office = await u.file("report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", emptyZip);
    const binary = await u.file("data.bin", "application/octet-stream", "binary-private-content");
    // A larger local file is a reference, so its full size does not consume the
    // 16 MiB rich-input transfer budget and it is never read into model input.
    await truncate(binary.path, 20 * 1024 * 1024);
    binary.size = (await stat(binary.path)).size;
    const prepared = await preparePrompt(message(archive, office, binary));
    assert.deepEqual(prepared.options, {});
    assert.match(prepared.text, /local file reference/);
    assert.match(prepared.text, /contents have not been decoded/);
    assert.ok(prepared.text.includes(JSON.stringify(await realpath(archive.path))));
    assert.ok(prepared.text.includes(JSON.stringify(await realpath(office.path))));
    assert.ok(prepared.text.includes(`Size: ${binary.size} bytes`));
    assert.doesNotMatch(prepared.text, /binary-private-content/);
    assert.doesNotMatch(prepared.timelineText, /Verified local path/);
    await assert.rejects(preparePrompt(message({ ...binary, size: ATTACHMENT_LIMITS.localReferenceBytes + 1 })), /256 MiB/);
  } finally { await u.cleanup(); }
});

test("text context and repository references preserve supplied text and external resource identity", async () => {
  const context: ProviderContent = {
    type: "text", mimeType: "text/plain", title: "src/app.ts", contextKind: "repository-file",
    text: "Repository file: src/app.ts\n1: export const a = 1;\n",
    externalResource: { provider: "github", providerLabel: "GitHub", resourceType: "file", id: "42", identifier: "src/app.ts", title: "Repository source", url: "https://example.test/repo/src/app.ts" },
  };
  const prepared = await preparePrompt(message({ type: "text", text: "Inspect @src/app.ts:1-5" }, context));
  assert.match(prepared.text, /Inspect @src\/app\.ts:1-5/);
  assert.match(prepared.text, /Context kind: repository-file/);
  assert.match(prepared.text, /Resource: GitHub \/ file \/ src\/app\.ts/);
  assert.match(prepared.text, /https:\/\/example\.test\/repo\/src\/app\.ts/);
  assert.equal(prepared.options.files?.[0].data, context.text);
  assert.doesNotMatch(prepared.timelineText, /export const/);
});

test("forge issues, change requests and code-review attachments keep meaningful structured context", async () => {
  const prepared = await preparePrompt(message(
    { type: "github_issue", mimeType: "application/github-issue", number: 12, title: "Broken login", url: "https://example.test/issues/12", body: "Reproduction steps" },
    { type: "github_pr", mimeType: "application/github-pr", number: 13, title: "Fix login", url: "https://example.test/pull/13", body: "PR details", baseRefName: "main", headRefName: "fix-login" },
    { type: "forge_issue", mimeType: "application/paseo-forge-issue", forge: "gitlab", number: 14, title: "GitLab issue", url: "https://example.test/issues/14", projectPath: "team/repo", body: "Issue details" },
    { type: "forge_change_request", mimeType: "application/paseo-forge-change-request", forge: "gitlab", number: 15, title: "Merge request", url: "https://example.test/merge_requests/15", projectPath: "team/repo", baseRefName: "main", headRefName: "feature", body: "MR details" },
    { type: "review", mimeType: "application/paseo-review", cwd: "/workspace/repo", mode: "base", baseRef: "main", comments: [{
      filePath: "src/login.ts", side: "new", lineNumber: 20, body: "Handle the empty token here.",
      context: { hunkHeader: "@@ -19,1 +19,2 @@", targetLine: { oldLineNumber: null, newLineNumber: 20, type: "add", content: "const token = input.token;" }, lines: [{ oldLineNumber: null, newLineNumber: 20, type: "add", content: "const token = input.token;" }] },
    }] },
  ));
  for (const expected of ["Reproduction steps", "PR details", "Base ref: main", "Head ref: fix-login", "Forge: gitlab", "Project: team/repo", "MR details", "src/login.ts (new line 20)", "Handle the empty token here.", "@@ -19,1 +19,2 @@", "const token = input.token;"])
    assert.ok(prepared.text.includes(expected), `Missing attachment context: ${expected}`);
  assert.doesNotMatch(prepared.timelineText, /Reproduction steps|const token|MR details/);
  assert.deepEqual(prepared.options, {});
});

test("attachment counts, per-file bounds, combined bounds and cancellation fail explicitly", async () => {
  await assert.rejects(preparePrompt(message(...Array.from({ length: ATTACHMENT_LIMITS.count + 1 }, () => image()))), /at most 20/);
  await assert.rejects(preparePrompt(message({ type: "text", text: "a".repeat(ATTACHMENT_LIMITS.textBytes + 1) })), /2 MiB/);
  const large = Buffer.alloc(ATTACHMENT_LIMITS.imageBytes);
  png.copy(large);
  await assert.rejects(preparePrompt(message(image(large.toString("base64")), image(large.toString("base64")))), /combined attachments/);
  const controller = new AbortController();
  controller.abort(new Error("Preparation cancelled"));
  await assert.rejects(preparePrompt(message(image()), { signal: controller.signal }), /Preparation cancelled/);
});

test("empty and command prompts are not silently turned into empty messages", async () => {
  await assert.rejects(preparePrompt(message()), /must contain/);
  await assert.rejects(preparePrompt({ clientMessageId: "command", delivery: "auto", input: { type: "command", name: "test", arguments: "" } }), /command prompts/);
});
