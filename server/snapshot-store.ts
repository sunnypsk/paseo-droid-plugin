import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ProviderEventSchema, type ProviderPersistence, type ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
const metadata = { nativeSessionId: z.string().uuid(), cwd: z.string() };
const rowSchema = z.custom<ProviderTimelineItem>((value) =>
  ProviderEventSchema.safeParse({ type: "timeline.item", sessionId: "restore", item: value }).success);
const legacySchema = z.object({ ...metadata, items: z.array(rowSchema) });
const referenceSchema = z.strictObject({ ...metadata, snapshotKey: keySchema });
const manifestSchema = z.strictObject({ version: z.literal(2), ...metadata, rows: z.array(keySchema) });
const headSchema = z.strictObject({ version: z.literal(2), ...metadata, manifestKey: keySchema });
export type TimelineSnapshot = z.infer<typeof legacySchema>;

export interface SnapshotStore {
  load(value: ProviderPersistence): Promise<TimelineSnapshot>;
  save(value: ProviderPersistence, previous?: ProviderPersistence): Promise<ProviderPersistence>;
}

function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }

/** Private, content-addressed snapshots. No native history is read or reconstructed. */
export class FileSnapshotStore implements SnapshotStore {
  private readonly encodedRows = new WeakMap<object, { key: string; text: string }>();
  private readonly written = new Set<string>();
  constructor(readonly directory = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-state", "droid-native", "v2")) {}

  async load(value: ProviderPersistence): Promise<TimelineSnapshot> {
    if (value.version === 1) return this.validateRows(legacySchema.parse(value.data));
    if (value.version !== 2) throw new Error("Unsupported Droid persistence version");
    const reference = referenceSchema.parse(value.data);
    try {
      const head = headSchema.parse(JSON.parse(await readFile(join(this.directory, "heads", `${reference.snapshotKey}.json`), "utf8")));
      if (head.nativeSessionId !== reference.nativeSessionId || head.cwd !== reference.cwd)
        throw new Error("Snapshot head identity does not match the saved session");
      const manifest = manifestSchema.parse(JSON.parse(await this.read("snapshots", head.manifestKey)));
      if (manifest.nativeSessionId !== reference.nativeSessionId || manifest.cwd !== reference.cwd)
        throw new Error("Snapshot identity does not match the saved session");
      const items: ProviderTimelineItem[] = [];
      // Bound simultaneous reads even for very long conversations.
      for (let offset = 0; offset < manifest.rows.length; offset += 16) {
        const rows = await Promise.all(manifest.rows.slice(offset, offset + 16).map(async (key) =>
          rowSchema.parse(JSON.parse(await this.read("rows", key)))));
        items.push(...rows);
      }
      return this.validateRows({ nativeSessionId: manifest.nativeSessionId, cwd: manifest.cwd, items });
    } catch {
      throw new Error("The saved Droid timeline snapshot is missing, damaged, or belongs to another session. Keep the snapshot files and restore them before reopening; no empty session was created.");
    }
  }

  async save(value: ProviderPersistence, previous?: ProviderPersistence): Promise<ProviderPersistence> {
    if (value.version !== 1) throw new Error("Snapshot writer requires a complete timeline snapshot");
    // TimelinePersistence already validates and freezes rows. Validate each new
    // row once; do not reparse or serialize unchanged history at every save.
    const data = value.data as unknown as TimelineSnapshot;
    const identity = z.object(metadata).parse(data);
    const old = previous?.version === 2 ? referenceSchema.parse(previous.data) : undefined;
    if (old && (old.nativeSessionId !== identity.nativeSessionId || old.cwd !== identity.cwd))
      throw new Error("Cannot replace the snapshot identity of another Droid session");
    const rows: string[] = [];
    for (let offset = 0; offset < data.items.length; offset += 16) {
      const keys = await Promise.all(data.items.slice(offset, offset + 16).map(async (row) => {
        let encoded = this.encodedRows.get(row);
        if (!encoded) {
          rowSchema.parse(row);
          const text = JSON.stringify(row);
          encoded = { key: digest(text), text };
          this.encodedRows.set(row, encoded);
        }
        await this.write("rows", encoded.key, encoded.text);
        return encoded.key;
      }));
      rows.push(...keys);
    }
    const manifest = JSON.stringify({ version: 2, ...identity, rows });
    const manifestKey = digest(manifest);
    await this.write("snapshots", manifestKey, manifest);
    // Paseo 0.11.4 can cache the handle captured at the foreground terminal.
    // A stable, private head lets that handle resolve later observed background
    // checkpoints without changing immutable rows or manifests or reading native history.
    const snapshotKey = old?.snapshotKey ?? digest(randomUUID());
    await this.atomicWrite("heads", snapshotKey, JSON.stringify({ version: 2, ...identity, manifestKey }));
    return { version: 2, data: { ...identity, snapshotKey } };
  }

  private validateRows(snapshot: TimelineSnapshot): TimelineSnapshot {
    if (new Set(snapshot.items.map((item) => item.id)).size !== snapshot.items.length)
      throw new Error("Saved Droid timeline contains duplicate row identities");
    return snapshot;
  }

  private async read(kind: string, key: string): Promise<string> {
    keySchema.parse(key);
    const text = await readFile(join(this.directory, kind, `${key}.json`), "utf8");
    if (digest(text) !== key) throw new Error("Snapshot checksum mismatch");
    return text;
  }

  private async write(kind: string, key: string, text: string): Promise<void> {
    const cacheKey = `${kind}/${key}`;
    if (this.written.has(cacheKey)) return;
    const directory = join(this.directory, kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${key}.json`);
    try {
      const existing = await readFile(target, "utf8");
      if (existing !== text) throw new Error("Existing snapshot failed its checksum");
      this.written.add(cacheKey);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.atomicWrite(kind, key, text);
    this.written.add(cacheKey);
  }

  private async atomicWrite(kind: string, key: string, text: string): Promise<void> {
    const directory = join(this.directory, kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${key}.json`);
    const temporary = join(directory, `.${key}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(text, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, target);
      // Persist the directory entry before a reference can escape over IPC.
      if (process.platform !== "win32") {
        const handle = await open(directory, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      }
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}
