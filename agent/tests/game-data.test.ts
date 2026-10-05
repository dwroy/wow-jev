import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GameDataClient, type GameVersion } from "../src/game-data/index.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const version: GameVersion = { branch: "retail", expansion: "midnight", patch: "12.1.0", build: 69933, region: "cn", locale: "zh_CN" };

test("real Python SQLite bridge keeps public seeds separate from exact client data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wow-game-data-test-"));
  try {
    const database = join(dir, "game.sqlite");
    execFileSync("/usr/bin/python3", ["-B", "-m", "game_database.cli", "--db", database, "import", "game-data/seeds/dragon-isles-reference-v1.json"], { cwd: root });
    const client = new GameDataClient({ repositoryDirectory: root, databasePath: database });
    assert.equal((await client.stats()).reference_only, 11);
    const actual = await client.lookup(version, { kind: "quest", entity_id: 70123 });
    assert.equal(actual.status, "not_found");
    assert.deepEqual(actual.records, []);
    const unknown = await client.lookup({ ...version, build: null }, { kind: "quest", entity_id: 70123 });
    assert.equal(unknown.status, "version_unknown");
    const refs = await client.references("retail", "zh_CN", { kind: "quest", name: "练手材料" });
    assert.equal(refs.status, "references");
    assert.deepEqual(new Set(refs.records.map((row) => row.entity_id)), new Set([70124, 65451]));
    assert.deepEqual(new Set(refs.records.map((row) => (row.facts.objectives as Array<{count:number}>)[0]!.count)), new Set([12, 15, 20]));
    assert.ok(refs.records.every((row) => row.reference_only && row.assertion_sha256.length === 64));
    assert.equal(refs.automatic_action_eligible, false);
    assert.equal((await client.references("classic-era", "zh_CN", { kind: "quest", entity_id: 70123 })).status, "not_found");
    assert.equal((await client.references("retail", "zh_TW", { kind: "quest", entity_id: 70123 })).status, "not_found");
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(client.stats(aborted.signal), /game_data_cancelled/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("read-only bridge rejects missing databases instead of creating them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wow-game-data-missing-"));
  try {
    const client = new GameDataClient({ repositoryDirectory: root, databasePath: join(dir, "missing.sqlite") });
    await assert.rejects(client.stats(), /game_data_query_failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
