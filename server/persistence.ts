import type { ProviderPersistence, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

type JsonValue = ProviderPersistence["data"];
type CachedRow = { source: ProviderTimelineItem; snapshot: JsonValue };
const jsonSchema = z.json();

function freezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Per-session snapshots. Callers replace a row object whenever its content changes. */
export class TimelinePersistence {
  private readonly rows = new Map<string, CachedRow>();

  build(nativeSessionId: string, cwd: string, items: ReadonlyMap<string, ProviderTimelineItem>): ProviderPersistence {
    for (const id of this.rows.keys()) {
      if (!items.has(id)) this.rows.delete(id);
    }
    const snapshots: JsonValue[] = [];
    for (const [id, source] of items) {
      let row = this.rows.get(id);
      if (!row || row.source !== source) {
        // Preserve the former JSON serialization semantics, including omitted
        // undefined object fields, while touching only new or replaced rows.
        const snapshot = freezeJson(jsonSchema.parse(JSON.parse(JSON.stringify(source))));
        row = { source, snapshot };
        this.rows.set(id, row);
      }
      snapshots.push(row.snapshot);
    }
    Object.freeze(snapshots);
    const data = Object.freeze({ nativeSessionId, cwd, items: snapshots });
    return Object.freeze({ version: 1, data });
  }
}
