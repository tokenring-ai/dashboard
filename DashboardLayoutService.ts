import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type TokenRingApp from "@tokenring-ai/app";
import type { TokenRingService } from "@tokenring-ai/app/types";
import { type DashboardLayoutRecord, DashboardLayoutRecordSchema, type DashboardLayoutSummary, MAX_LAYOUT_BYTES } from "./rpc/schema.ts";

/** Layouts of users without an authenticated name share this scope. */
export const DEFAULT_SCOPE = "default";

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Filesystem-safe scope derived from a username (or the default scope).
 *
 * A readable lowercase slug plus a short hash of the *exact* username: the slug
 * alone collides ("a b" vs "a-b", and "Bob" vs "bob" on case-insensitive
 * filesystems), and the hash keeps distinct usernames in distinct directories.
 * Always lowercase and always starting with an alphanumeric, so it satisfies
 * SAFE_SEGMENT whatever the username looks like ("_alice", "..", "日本").
 */
export function scopeForUsername(username: string | null | undefined): string {
  if (!username || username.trim().length === 0) return DEFAULT_SCOPE;
  const hash = createHash("sha256").update(username, "utf8").digest("hex").slice(0, 12);
  const slug = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, 48);
  return slug.length > 0 ? `${slug}-${hash}` : `u-${hash}`;
}

/**
 * The scope older builds derived from a username. Only used to find layouts
 * saved before the collision-free encoding so they can be carried over.
 */
export function legacyScopeForUsername(username: string | null | undefined): string {
  if (!username) return DEFAULT_SCOPE;
  const cleaned = username
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : DEFAULT_SCOPE;
}

export type SaveLayoutInput = Omit<DashboardLayoutRecord, "updatedAt"> & { expectedUpdatedAt?: number | undefined };
export type SaveLayoutResult = { status: "success"; updatedAt: number } | { status: "conflict"; record: DashboardLayoutRecord };

/**
 * Stores one JSON file per dashboard under `<workspace>/dashboards/<scope>/`.
 * Reads are cached in memory; writes are atomic (temp file + rename).
 * Every mutation of one (scope, dashboard) pair runs under a per-key lock, so
 * the optimistic-concurrency check and the write it guards are one step.
 */
export default class DashboardLayoutService implements TokenRingService {
  readonly name = "DashboardLayoutService";
  readonly description = "Persists per-user dashboard layouts for the web frontend";

  private cache = new Map<string, DashboardLayoutRecord | null>();
  private locks = new Map<string, Promise<unknown>>();
  /** Highest `updatedAt` issued per key, so stamps stay strictly increasing even across deletes. */
  private lastIssued = new Map<string, number>();
  private migrations = new Map<string, Promise<void>>();

  constructor(private readonly app: TokenRingApp) {}

  getDirectory(): string {
    return this.app.getWorkspaceResolvedPath("dashboards");
  }

  /**
   * Scope for a username, carrying over layouts saved under the pre-hash
   * directory name on first use. The old directory is copied, not moved: on
   * case-insensitive filesystems it may hold layouts of several usernames.
   */
  async scopeFor(username: string | null | undefined): Promise<string> {
    const scope = scopeForUsername(username);
    const legacy = legacyScopeForUsername(username);
    if (legacy === scope || !SAFE_SEGMENT.test(legacy)) return scope;
    let migration = this.migrations.get(scope);
    if (!migration) {
      migration = this.migrateLegacyScope(legacy, scope).catch(error => {
        this.migrations.delete(scope);
        this.app.serviceError(this, `Failed to migrate dashboard layouts from ${legacy} to ${scope}`, error);
      });
      this.migrations.set(scope, migration);
    }
    await migration;
    return scope;
  }

  private async migrateLegacyScope(legacy: string, scope: string): Promise<void> {
    const target = path.join(this.getDirectory(), scope);
    try {
      await fs.access(target);
      return; // already migrated (or saved to) under the new scope
    } catch {
      // not there yet
    }
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(this.getDirectory(), legacy));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const files = entries.filter(entry => entry.endsWith(".json"));
    if (files.length === 0) return;
    await fs.mkdir(target, { recursive: true });
    for (const file of files) {
      await fs.copyFile(path.join(this.getDirectory(), legacy, file), path.join(target, file), fs.constants.COPYFILE_EXCL).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
  }

  private filePath(scope: string, dashboardId: string): string {
    if (!SAFE_SEGMENT.test(scope) || !SAFE_SEGMENT.test(dashboardId)) {
      throw new Error(`Invalid dashboard scope or id: ${scope}/${dashboardId}`);
    }
    return path.join(this.getDirectory(), scope, `${dashboardId}.json`);
  }

  private cacheKey(scope: string, dashboardId: string): string {
    return `${scope}/${dashboardId}`;
  }

  /** Runs `task` after every earlier task for `key` has settled. */
  private withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    this.locks.set(key, run);
    const release = () => {
      if (this.locks.get(key) === run) this.locks.delete(key);
    };
    run.then(release, release);
    return run;
  }

  async get(scope: string, dashboardId: string): Promise<DashboardLayoutRecord | null> {
    const key = this.cacheKey(scope, dashboardId);
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const file = this.filePath(scope, dashboardId);
    let record: DashboardLayoutRecord | null = null;
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = DashboardLayoutRecordSchema.safeParse(JSON.parse(raw));
      record = parsed.success && parsed.data.dashboardId === dashboardId ? parsed.data : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.app.serviceError(this, `Failed to read dashboard layout ${scope}/${dashboardId}`, error);
      }
    }
    // A save that finished while this read was in flight already cached a newer record.
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    this.cache.set(key, record);
    return record;
  }

  async save(scope: string, input: SaveLayoutInput): Promise<SaveLayoutResult> {
    if (Buffer.byteLength(input.layout, "utf8") > MAX_LAYOUT_BYTES) {
      throw new Error(`Dashboard layout exceeds ${MAX_LAYOUT_BYTES} bytes`);
    }
    const key = this.cacheKey(scope, input.dashboardId);
    // Validate before queueing so a bad id fails fast.
    this.filePath(scope, input.dashboardId);
    return this.withLock(key, async () => {
      const existing = await this.get(scope, input.dashboardId);
      if (existing && input.expectedUpdatedAt !== undefined && existing.updatedAt > input.expectedUpdatedAt) {
        return { status: "conflict", record: existing };
      }
      const floor = Math.max(existing?.updatedAt ?? 0, this.lastIssued.get(key) ?? 0);
      const updatedAt = Math.max(Date.now(), floor + 1);
      this.lastIssued.set(key, updatedAt);
      const record: DashboardLayoutRecord = {
        dashboardId: input.dashboardId,
        schemaVersion: input.schemaVersion,
        viewRegistryHash: input.viewRegistryHash,
        layout: input.layout,
        updatedAt,
      };
      // A layout save from a user app need not resend its name; keep what is stored.
      const app = input.app ?? existing?.app;
      if (app) record.app = app;
      await this.writeRecord(scope, record);
      this.cache.set(key, record);
      return { status: "success", updatedAt };
    });
  }

  async delete(scope: string, dashboardId: string): Promise<boolean> {
    const key = this.cacheKey(scope, dashboardId);
    const file = this.filePath(scope, dashboardId);
    return this.withLock(key, async () => {
      this.cache.set(key, null);
      try {
        await fs.unlink(file);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
  }

  async list(scope: string): Promise<DashboardLayoutSummary[]> {
    if (!SAFE_SEGMENT.test(scope)) throw new Error(`Invalid dashboard scope: ${scope}`);
    const directory = path.join(this.getDirectory(), scope);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: DashboardLayoutSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.get(scope, entry.slice(0, -".json".length));
      if (!record) continue;
      const { layout: _layout, ...summary } = record;
      summaries.push(summary);
    }
    return summaries.sort((a, b) => a.dashboardId.localeCompare(b.dashboardId));
  }

  /** Callers hold the key's lock, so writes for one key never overlap. */
  private async writeRecord(scope: string, record: DashboardLayoutRecord): Promise<void> {
    const file = this.filePath(scope, record.dashboardId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(temp, JSON.stringify(record), "utf8");
    await fs.rename(temp, file);
  }
}
