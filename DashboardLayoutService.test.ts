import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import DashboardLayoutService, { legacyScopeForUsername, scopeForUsername } from "./DashboardLayoutService.ts";
import { MAX_LAYOUT_BYTES } from "./rpc/schema.ts";

function fakeApp(workspace: string) {
  return {
    getWorkspaceResolvedPath: (relative: string) => path.join(workspace, relative),
    serviceError: () => {},
  } as unknown as ConstructorParameters<typeof DashboardLayoutService>[0];
}

describe("DashboardLayoutService", () => {
  let workspace: string;
  let service: DashboardLayoutService;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tokenring-dashboards-"));
    service = new DashboardLayoutService(fakeApp(workspace));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("round-trips a record through disk and cache", async () => {
    const saved = await service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "abc", layout: "{}" });
    expect(saved.status).toBe("success");

    const fresh = new DashboardLayoutService(fakeApp(workspace));
    const record = await fresh.get("alice", "home");
    expect(record?.layout).toBe("{}");
    expect(record?.updatedAt).toBe(saved.status === "success" ? saved.updatedAt : -1);
    expect(await fs.readdir(path.join(workspace, "dashboards", "alice"))).toEqual(["home.json"]);
  });

  it("keeps a user app's metadata across saves that omit it, and lists it", async () => {
    const app = { label: "My agents", icon: "bot", basedOn: "agents" };
    await service.save("alice", { dashboardId: "layout-my-agents", schemaVersion: 2, viewRegistryHash: "", layout: "1", app });
    await service.save("alice", { dashboardId: "layout-my-agents", schemaVersion: 2, viewRegistryHash: "", layout: "2" });
    const fresh = new DashboardLayoutService(fakeApp(workspace));
    const record = await fresh.get("alice", "layout-my-agents");
    expect(record?.layout).toBe("2");
    expect(record?.app).toEqual(app);
    const listed = await fresh.list("alice");
    expect(listed.find(r => r.dashboardId === "layout-my-agents")?.app).toEqual(app);
  });

  it("isolates scopes", async () => {
    await service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "1" });
    await service.save("bob", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "2" });
    expect((await service.get("alice", "home"))?.layout).toBe("1");
    expect((await service.get("bob", "home"))?.layout).toBe("2");
    expect(await service.get("carol", "home")).toBeNull();
  });

  it("reports conflicts when the stored record is newer than expected", async () => {
    const first = await service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "1" });
    const firstUpdatedAt = first.status === "success" ? first.updatedAt : 0;
    const second = await service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "2" });
    expect(second.status).toBe("success");

    const stale = await service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "3", expectedUpdatedAt: firstUpdatedAt });
    expect(stale.status).toBe("conflict");
    if (stale.status === "conflict") expect(stale.record.layout).toBe("2");
  });

  it("rejects oversized layouts", async () => {
    await expect(
      service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "x".repeat(MAX_LAYOUT_BYTES + 1) }),
    ).rejects.toThrow(/exceeds/);
  });

  it("deletes and lists records", async () => {
    await service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "1" });
    await service.save("alice", { dashboardId: "terminal", schemaVersion: 1, viewRegistryHash: "a", layout: "1" });
    expect((await service.list("alice")).map(entry => entry.dashboardId)).toEqual(["home", "terminal"]);
    expect(await service.delete("alice", "home")).toBe(true);
    expect(await service.delete("alice", "home")).toBe(false);
    expect((await service.list("alice")).map(entry => entry.dashboardId)).toEqual(["terminal"]);
    expect(await service.list("nobody")).toEqual([]);
  });

  it("rejects unsafe ids", async () => {
    await expect(service.get("alice", "../etc")).rejects.toThrow(/Invalid/);
  });

  it("derives filesystem-safe scopes from usernames", () => {
    expect(scopeForUsername(null)).toBe("default");
    expect(scopeForUsername("  ")).toBe("default");
    expect(scopeForUsername("mark@example.com")).toMatch(/^mark-example\.com-[0-9a-f]{12}$/);
    expect(scopeForUsername("../x")).toMatch(/^x-[0-9a-f]{12}$/);
    expect(scopeForUsername("default")).not.toBe("default");
  });

  it("gives every username a valid, distinct, case-safe scope", async () => {
    const names = ["_alice", "Bob", "bob", "a b", "a-b", "..", "日本", "-", "default"];
    const scopes = names.map(scopeForUsername);
    for (const scope of scopes) expect(scope).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    // Distinct even after case folding (case-insensitive filesystems).
    expect(new Set(scopes.map(scope => scope.toLowerCase())).size).toBe(names.length);
    // A leading underscore used to fail SAFE_SEGMENT, so every RPC threw.
    const saved = await service.save(scopeForUsername("_alice"), { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "1" });
    expect(saved.status).toBe("success");
    await service.save(scopeForUsername("Bob"), { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "upper" });
    await service.save(scopeForUsername("bob"), { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "lower" });
    const fresh = new DashboardLayoutService(fakeApp(workspace));
    expect((await fresh.get(scopeForUsername("Bob"), "home"))?.layout).toBe("upper");
    expect((await fresh.get(scopeForUsername("bob"), "home"))?.layout).toBe("lower");
  });

  it("carries layouts over from the legacy scope directory", async () => {
    await service.save(legacyScopeForUsername("mark@example.com"), { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "old" });
    const fresh = new DashboardLayoutService(fakeApp(workspace));
    const scope = await fresh.scopeFor("mark@example.com");
    expect(scope).toBe(scopeForUsername("mark@example.com"));
    expect((await fresh.get(scope, "home"))?.layout).toBe("old");
    // A later reset is not undone by re-reading the legacy copy.
    await fresh.delete(scope, "home");
    const again = new DashboardLayoutService(fakeApp(workspace));
    expect(await again.get(await again.scopeFor("mark@example.com"), "home")).toBeNull();
  });

  it("serialises the concurrency check with the write", async () => {
    const base = await service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "0" });
    const expectedUpdatedAt = base.status === "success" ? base.updatedAt : 0;
    // Two saves against the same expected stamp, issued while one write is in flight.
    const [first, second] = await Promise.all([
      service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "1", expectedUpdatedAt }),
      service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "2", expectedUpdatedAt }),
    ]);
    expect(first.status).toBe("success");
    expect(second.status).toBe("conflict");
    if (second.status === "conflict") expect(second.record.layout).toBe("1");
  });

  it("issues strictly increasing stamps, even for same-millisecond saves and across deletes", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(n => service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: String(n) })),
    );
    const stamps = results.map(result => (result.status === "success" ? result.updatedAt : -1));
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]!).toBeGreaterThan(stamps[i - 1]!);
    await service.delete("alice", "home");
    const after = await service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "6" });
    expect(after.status === "success" ? after.updatedAt : -1).toBeGreaterThan(stamps.at(-1)!);
  });

  it("does not let a delete race a save", async () => {
    const save = service.save("alice", { dashboardId: "home", schemaVersion: 1, viewRegistryHash: "a", layout: "1" });
    const deleted = service.delete("alice", "home");
    await save;
    expect(await deleted).toBe(true);
    const fresh = new DashboardLayoutService(fakeApp(workspace));
    expect(await fresh.get("alice", "home")).toBeNull();
  });
});
