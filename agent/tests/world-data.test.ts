import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { GameDataClient, WorldDataClient, type GameVersion, type WorldSelector } from "../src/game-data/index.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// During parallel implementation only; integrated tests use the current checkout by default.
const pythonRepository = resolve(process.env.WORLD_DATA_TEST_PYTHON_REPOSITORY ?? root);
const version: GameVersion = { branch: "retail", expansion: "midnight", patch: "12.1.0", build: 69933, region: "cn", locale: "zh_CN" };
const previousVersion: GameVersion = { ...version, patch: "12.0.1", build: 69800 };
const selector = (nativeId = 1001, predicates: string[] | null = null): WorldSelector => ({ namespace: "retail", kind: "quest", native_id: nativeId, name: null, predicates });
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Synthetic offline data, built and queried by the actual Python/SQLite implementation. */
async function fixture(options: { largeValue?: boolean; unsafeId?: boolean; floatEvidence?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "world-data-test-"));
  try {
    const repository = join(dir, "repository");
    await cp(join(pythonRepository, "game_database"), join(repository, "game_database"), { recursive: true, filter: source => !source.includes("__pycache__") });
    for (const schema of ["schema-v1.json", "schema-v2.json"]) await copyFile(join(root, "game_database", schema), join(repository, "game_database", schema));
    const artifact = Buffer.from("离线测试来源；不代表当前客户端实测。\n");
    await writeFile(join(dir, "source.txt"), artifact);
    const source = (revision: string, sourceVersion = version) => ({ provider: "offline-fixture", revision, source_version: sourceVersion,
      url: "https://example.org/offline-fixture", retrieved_at: "2026-10-06T00:00:00Z", license: { code: "MIT", data: "MIT", images: null, distribution: "local_only" },
      third_party: [{ provider: "synthetic-fixture", license: "MIT", note: "测试原件" }], note: "合成离线契约测试，不是游戏验收" });
    const current = source("fixture-current"), old = source("fixture-old", previousVersion), reference = source("fixture-reference");
    const key = (native_id: number) => ({ namespace: "retail", kind: "quest", native_id });
    const assertion = (nativeId: number, predicate: string, state: string, value: unknown, s = current, applicable = true) => ({
      entity: key(nativeId), predicate, state, value, source_sha256: hash(canonical(s)), artifact_sha256: hash(artifact), locator: `fixture:${nativeId}:${predicate}`,
      observed_at: "2026-10-06T00:00:00Z", condition: { op: "true" }, verification: applicable ? "source_verified" : "reference_only",
      applicability: applicable ? [{ version: s.source_version, method: "source_exact_build", evidence_url: s.url, verified_at: "2026-10-06T00:00:00Z", evidence_sha256: hash(artifact) }] : [],
    });
    const assertions = [
      assertion(1001, "name", "known", "练手材料"), assertion(1002, "name", "known", "练手材料"),
      assertion(1001, "objective.count", "known", 12), assertion(1001, "objective.count", "known", 10, old),
      assertion(1001, "objective.count", "known", 15, reference, false),
      assertion(1001, "route", "unknown", null), assertion(1001, "flight", "unsupported", null), assertion(1001, "reward", "not_present", null),
      assertion(1001, "faction", "known", "Alliance"), assertion(1001, "faction", "known", "Horde", reference),
      { ...assertion(1001, "conditional", "known", 99), condition: { op: "false" } },
    ];
    if (options.largeValue) assertions.push(assertion(1001, "description", "known", "文".repeat(65000)));
    const bundle = { schema_version: 2, scope: "offline-test", sources: [current, old, reference], artifacts: [{ sha256: hash(artifact), path: "source.txt", media_type: "text/plain" }],
      entities: [1001, 1002].map(nativeId => ({ key: key(nativeId), content_expansion: "dragonflight" })), assertions, migration: [] };
    const addFloat = options.floatEvidence ? "; a=b['assertions'][2].copy(); a['predicate']='measurement'; a['value']={'ratio':1.0,'label':'中文🗺️𝄞é'}; b['assertions'].append(a)" : "";
    const code = `import json,sys; from game_database.v2.pack import build_pack; b=json.load(sys.stdin)${addFloat}; print(json.dumps(build_pack(b,sys.argv[1],evidence_root=sys.argv[2])))`;
    const pack = JSON.parse(execFileSync("/usr/bin/python3", ["-B", "-c", code, join(dir, "world"), dir], { cwd: repository, input: JSON.stringify(bundle), encoding: "utf8" })) as { directory: string; world_pack_sha256: string };
    if (options.unsafeId) {
      // Python int64 remains precise; this response must be refused by the number-based TS bridge.
      const mutate = "import sys; from pathlib import Path; from game_database.v2.pack import build_pack; from game_database.store import parse_json,canonical; b=parse_json(sys.stdin.read()); b['entities'][1]['key']['native_id']=2**53+1; b['assertions'][1]['entity']['native_id']=2**53+1; print(canonical(build_pack(b,sys.argv[1],evidence_root=sys.argv[2])))";
      const unsafePack = JSON.parse(execFileSync("/usr/bin/python3", ["-B", "-c", mutate, join(dir, "unsafe"), dir], { cwd: repository, input: JSON.stringify(bundle), encoding: "utf8" })) as typeof pack;
      pack.directory = unsafePack.directory; pack.world_pack_sha256 = unsafePack.world_pack_sha256;
    }
    const client = (overrides: { pythonExecutable?: string; timeoutMs?: number; worldPackSha256?: string } = {}) => new WorldDataClient({ repositoryDirectory: repository, worldPackDirectory: pack.directory, worldPackSha256: pack.world_pack_sha256, ...overrides });
    return { dir, repository, pack, client, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

test("真实 Python/SQLite 批量查询保留字段状态、冲突、来源许可与固定包 SHA", async () => {
  const f = await fixture();
  try {
    const result = await f.client().lookup(version, [selector(1001, ["name", "objective.count", "route", "flight", "reward", "faction", "missing", "conditional"]), selector(1002, ["name"])]);
    assert.equal(result.world_pack_sha256, f.pack.world_pack_sha256); assert.equal(result.automatic_action_eligible, false);
    assert.equal(result.results.length, 2); assert.equal(result.results[0]!.status, "conflict"); assert.equal(result.results[1]!.status, "found");
    const fields = result.results[0]!.entities[0]!.fields;
    assert.equal(fields["objective.count"]!.value, 12); assert.equal(fields.route!.status, "unknown"); assert.equal(fields.flight!.status, "unsupported");
    assert.equal(fields.reward!.status, "not_present"); assert.equal(fields.faction!.status, "conflict"); assert.equal(fields.faction!.value, null);
    assert.deepEqual(fields.faction!.assertion_ids, []); assert.equal(fields.faction!.assertions.length, 2);
    assert.equal(fields.conditional!.status, "unknown"); assert.deepEqual(fields.conditional!.assertion_ids, []); assert.equal(fields.conditional!.assertions.length, 1);
    assert.deepEqual(fields.missing, { status: "unknown", value: null, assertion_ids: [], assertions: [] });
    const record = fields.name!.assertions[0]!;
    assert.equal(hash(record.assertion_canonical), record.assertion_sha256); assert.equal(hash(record.source_canonical), record.source_sha256);
    assert.deepEqual(record.source_revision.license, { code: "MIT", data: "MIT", images: null, distribution: "local_only" });
    assert.equal(record.source_revision.third_party[0]!.provider, "synthetic-fixture"); assert.equal(record.source_revision.revision, "fixture-current");
    assert.equal(record.artifact_sha256?.length, 64); assert.deepEqual(fields.name!.assertion_ids, [record.assertion_sha256]);
  } finally { await f.cleanup(); }
});

test("六维精确隔离、unknown、同名歧义与参考查询均不授权输入", async () => {
  const f = await fixture();
  try {
    const client = f.client();
    for (const differing of [{ branch: "classic-era" }, { expansion: "dragonflight" }, { patch: "12.1.1" }, { build: 69934 }, { region: "us" }, { locale: "en_US" }] as Partial<GameVersion>[]) {
      const result = await client.lookup({ ...version, ...differing }, [selector(1001, ["objective.count"])]);
      assert.equal(result.results[0]!.status, "not_found", JSON.stringify(differing)); assert.deepEqual(result.results[0]!.entities, []);
    }
    for (const unknown of [{ branch: "unknown" }, { expansion: null }, { patch: null }, { build: null }, { region: null }, { locale: null }] as Partial<GameVersion>[]) {
      assert.equal((await client.lookup({ ...version, ...unknown }, [selector()])).results[0]!.status, "version_unknown");
    }
    assert.equal((await client.lookup(previousVersion, [selector(1001, ["objective.count"])] )).results[0]!.entities[0]!.fields["objective.count"]!.value, 10);
    const byName: WorldSelector = { namespace: "retail", kind: "quest", native_id: null, name: "练手材料", predicates: ["name"] };
    assert.equal((await client.lookup(version, [byName])).results[0]!.status, "ambiguous");
    const refs = await client.references(version, [selector(1001, ["objective.count"]), byName]);
    assert.equal(refs.automatic_action_eligible, false); assert.equal(refs.results[0]!.status, "references"); assert.equal(refs.results[0]!.entities[0]!.fields["objective.count"]!.status, "conflict");
    assert.deepEqual(new Set(refs.results[0]!.entities[0]!.fields["objective.count"]!.assertions.map(a => a.value)), new Set([10, 12, 15]));
    assert.ok(refs.results.every(r => r.applicable_to_requested_client === false && r.automatic_action_eligible === false));
    assert.equal(refs.results[1]!.status, "ambiguous");
  } finally { await f.cleanup(); }
});

test("固定包拒绝错误 SHA、manifest/SQLite/原件篡改", async () => {
  for (const mutation of ["pin", "manifest", "database", "artifact"] as const) {
    const f = await fixture();
    try {
      if (mutation !== "pin") {
        const name = mutation === "manifest" ? "manifest.json" : mutation === "database" ? "world.sqlite" : `artifacts/${hash(Buffer.from("离线测试来源；不代表当前客户端实测。\n"))}`;
        const file = join(f.pack.directory, name); await chmod(file, 0o600); const before = await readFile(file);
        await writeFile(file, mutation === "manifest" ? before.toString("utf8").replace('"scope":"offline-test"', '"scope":"tampered"') : Buffer.concat([before, Buffer.from("tampered")]));
      }
      const client = mutation === "pin" ? f.client({ worldPackSha256: "0".repeat(64) }) : f.client();
      await assert.rejects(client.lookup(version, [selector()]), /world_data_query_failed:world: (manifest|database|artifact) content hash mismatch/);
    } finally { await f.cleanup(); }
  }
});

test("取消、超时、子进程故障与查询预算保持有界", async () => {
  const f = await fixture();
  try {
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(f.client().lookup(version, [selector()], cancelled.signal), /world_data_cancelled/);
    const wrapper = join(f.dir, "slow-python");
    await writeFile(wrapper, "#!/usr/bin/python3\nimport os,sys,time\ntime.sleep(1)\nos.execv('/usr/bin/python3', ['/usr/bin/python3', *sys.argv[1:]])\n", { mode: 0o700 });
    const active = new AbortController(); const pending = f.client({ pythonExecutable: wrapper }).lookup(version, [selector()], active.signal);
    const timer = setTimeout(() => active.abort(), 30); try { await assert.rejects(pending, /world_data_cancelled/); } finally { clearTimeout(timer); }
    await assert.rejects(f.client({ pythonExecutable: wrapper, timeoutMs: 100 }).lookup(version, [selector()]), /world_data_timeout/);
    await assert.rejects(f.client({ pythonExecutable: join(f.dir, "missing-python") }).lookup(version, [selector()]), /world_data_process_failed/);
    await assert.rejects(f.client().lookup(version, Array.from({ length: 129 }, () => selector())), /world_data_request_invalid/);
    await assert.rejects(f.client().lookup(version, []), /world_data_request_invalid/);
    await assert.rejects(f.client().lookup(version, [{ ...selector(), name: "练手材料" }]), /world_data_request_invalid/);
    await assert.rejects(f.client().lookup(version, [{ ...selector(), native_id: Number.MAX_SAFE_INTEGER + 1 }]), /world_data_request_invalid/);
    await assert.rejects(f.client().lookup(version, Array.from({ length: 128 }, () => ({ ...selector(), native_id: null, name: "文".repeat(512) }))), /world_data_request_limit/);
  } finally { await f.cleanup(); }
});

test("响应配额与不能精确保留的 int64 实体身份拒绝", async () => {
  const large = await fixture({ largeValue: true });
  try { await assert.rejects(large.client().lookup(version, Array.from({ length: 32 }, () => selector(1001, ["description"]))), /world_data_query_failed:bridge: response limit/); }
  finally { await large.cleanup(); }
  const unsafe = await fixture({ unsafeId: true });
  try { await assert.rejects(unsafe.client().lookup(version, [{ namespace: "retail", kind: "quest", native_id: null, name: "练手材料", predicates: ["name"] }]), /world_data_response_invalid/); }
  finally { await unsafe.cleanup(); }
});

test("统一 schema 拒绝宽松响应、缺许可字段及自动执行资格", async () => {
  const f = await fixture();
  try {
    const ajv = new Ajv({ strict: true });
    ajv.addSchema(JSON.parse(await readFile(join(root, "game_database/schema-v1.json"), "utf8")) as object);
    ajv.addSchema(JSON.parse(await readFile(join(root, "game_database/schema-v2.json"), "utf8")) as object);
    const validate = ajv.compile({ $ref: "urn:wow-jev:world-data-v2#/$defs/response" });
    const response = { schema_version: 2, ok: true, result: await f.client().lookup(version, [selector(1001, ["name"])]) };
    assert.equal(validate(response), true);
    for (const mutation of ["extra", "license", "eligible", "state", "assertion_state", "verification", "missing_canonical"] as const) {
      const forged = structuredClone(response) as Record<string, any>;
      if (mutation === "extra") forged.unknown = true;
      if (mutation === "eligible") forged.result.automatic_action_eligible = true;
      if (mutation === "license") delete forged.result.results[0].entities[0].fields.name.assertions[0].source_revision.license.data;
      if (mutation === "state") forged.result.results[0].entities[0].fields.name.status = "success";
      if (mutation === "assertion_state") forged.result.results[0].entities[0].fields.name.assertions[0].state = "unknown";
      if (mutation === "verification") forged.result.results[0].entities[0].fields.name.assertions[0].verification = "reference_only";
      if (mutation === "missing_canonical") delete forged.result.results[0].entities[0].fields.name.assertions[0].assertion_canonical;
      assert.equal(validate(forged), false, mutation);
    }
  } finally { await f.cleanup(); }
});

test("真实结果被替换包/版本/实体/采纳依据或重复 JSON 字段时拒绝", async () => {
  const f = await fixture();
  try {
    const edits: Record<string, string> = {
      pack: "r['result']['world_pack_sha256']='0'*64",
      version: "r['result']['results'][0]['requested_version']['build']=69934",
      entity: "r['result']['results'][0]['entities'][0]['key']['native_id']=1002",
      adopted: "r['result']['results'][0]['entities'][0]['fields']['name']['assertion_ids']=[]",
      rule: "r['result']['results'][0]['rule_version']='field-resolution-future'",
      duplicate: "pass",
    };
    for (const [mutation, edit] of Object.entries(edits)) {
      const wrapper = join(f.dir, `mutating-python-${mutation}`);
      const output = mutation === "duplicate" ? `duplicate = '{"ok":false,' + json.dumps(r)[1:]\njson.loads(duplicate)\nprint(duplicate)` : "print(json.dumps(r))";
      await writeFile(wrapper, `#!/usr/bin/python3\nimport json,subprocess,sys\np=subprocess.run([sys.executable,*sys.argv[1:]],input=sys.stdin.buffer.read(),stdout=subprocess.PIPE,stderr=subprocess.PIPE)\nr=json.loads(p.stdout)\n${edit}\n${output}\n`, { mode: 0o700 });
      if (mutation === "duplicate") {
        const raw = execFileSync(wrapper, ["-B", "-m", "game_database.v2.bridge"], { cwd: f.repository, encoding: "utf8", input: JSON.stringify({ schema_version: 2,
          operation: "lookup", directory: f.pack.directory, world_pack_sha256: f.pack.world_pack_sha256, version, selectors: [selector(1001, ["name"])] }) });
        assert.doesNotThrow(() => JSON.parse(raw)); assert.equal((raw.match(/"ok"\s*:/g) ?? []).length, 2); assert.equal((JSON.parse(raw) as { ok: boolean }).ok, true);
      }
      await assert.rejects(f.client({ pythonExecutable: wrapper }).lookup(version, [selector(1001, ["name"])]), ["adopted", "duplicate", "rule"].includes(mutation) ? /world_data_response_invalid/ : /world_data_response_binding/, mutation);
    }
  } finally { await f.cleanup(); }
});

test("总体 status 不得把真实字段 conflict 改成 found", async () => {
  const f = await fixture();
  try {
    const original = await f.client().lookup(version, [selector(1001, ["faction"])]);
    assert.equal(original.results[0]!.status, "conflict");
    const wrapper = join(f.dir, "status-python");
    await writeFile(wrapper, "#!/usr/bin/python3\nimport json,subprocess,sys\np=subprocess.run([sys.executable,*sys.argv[1:]],input=sys.stdin.buffer.read(),stdout=subprocess.PIPE,stderr=subprocess.PIPE)\nr=json.loads(p.stdout)\nr['result']['results'][0]['status']='found'\nprint(json.dumps(r))\n", { mode: 0o700 });
    await assert.rejects(f.client({ pythonExecutable: wrapper }).lookup(version, [selector(1001, ["faction"])]), /world_data_response_binding/);
  } finally { await f.cleanup(); }
});

test("字段和来源同时伪造、原 canonical 字节篡改不能沿用旧 SHA", async () => {
  const f = await fixture();
  try {
    const edits: Record<string, string> = {
      values: "field['value']=999; a['value']=999",
      source: "a['source_revision']['note']='伪造来源'; a['source_revision']['license']['data']='伪造许可'",
      both: "field['value']=999; a['value']=999; a['source_revision']['note']='伪造来源'",
      assertion_bytes: "a['assertion_canonical']+=' '",
      source_bytes: "a['source_canonical']+=' '",
      assertion_json: "p=json.loads(a['assertion_canonical']); p['value']=999; a['assertion_canonical']=json.dumps(p,ensure_ascii=False)",
      source_json: "p=json.loads(a['source_canonical']); p['note']='伪造来源'; a['source_canonical']=json.dumps(p,ensure_ascii=False)",
    };
    for (const [mutation, edit] of Object.entries(edits)) {
      const wrapper = join(f.dir, `evidence-python-${mutation}`);
      await writeFile(wrapper, `#!/usr/bin/python3\nimport json,subprocess,sys\np=subprocess.run([sys.executable,*sys.argv[1:]],input=sys.stdin.buffer.read(),stdout=subprocess.PIPE,stderr=subprocess.PIPE)\nr=json.loads(p.stdout)\nfield=r['result']['results'][0]['entities'][0]['fields']['objective.count']\na=field['assertions'][0]\n${edit}\nprint(json.dumps(r))\n`, { mode: 0o700 });
      await assert.rejects(f.client({ pythonExecutable: wrapper }).lookup(version, [selector(1001, ["objective.count"])]), /world_data_response_binding/, mutation);
    }
  } finally { await f.cleanup(); }
});

test("Python 的 1.0、中文及 Unicode 原始证据字节保持 SHA 与外层 JSON 值一致", async () => {
  const f = await fixture({ floatEvidence: true });
  try {
    const result = await f.client().lookup(version, [selector(1001, ["measurement"])]);
    const field = result.results[0]!.entities[0]!.fields.measurement!; const a = field.assertions[0]!;
    assert.deepEqual(field.value, { ratio: 1, label: "中文🗺️𝄞é" });
    assert.ok(a.assertion_canonical.includes('"ratio":1.0'));
    assert.ok(a.assertion_canonical.includes("中文🗺️𝄞é")); assert.ok(a.source_canonical.includes("合成离线契约测试"));
    assert.equal(hash(a.assertion_canonical), a.assertion_sha256); assert.equal(hash(a.source_canonical), a.source_sha256);
    assert.notEqual(hash(canonical(JSON.parse(a.assertion_canonical) as unknown)), a.assertion_sha256);
  } finally { await f.cleanup(); }
});

test("v1 seed/精确查询与参考接口在新增世界桥后保持原语义", async () => {
  const dir = await mkdtemp(join(tmpdir(), "world-v1-regression-"));
  try {
    const database = join(dir, "game.sqlite");
    execFileSync("/usr/bin/python3", ["-B", "-m", "game_database.cli", "--db", database, "import", "game-data/seeds/dragon-isles-reference-v1.json"], { cwd: root });
    const client = new GameDataClient({ repositoryDirectory: root, databasePath: database });
    assert.equal((await client.stats()).reference_only, 11); assert.equal((await client.lookup(version, { kind: "quest", entity_id: 70123 })).status, "not_found");
    assert.equal((await client.references("retail", "zh_CN", { kind: "quest", name: "练手材料" })).status, "references");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
