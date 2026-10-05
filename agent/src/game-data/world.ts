import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import type { GameDataProof, GameVersion } from "./types.js";

export type WorldEntityKind = "creature" | "quest" | "item" | "spell" | "zone" | "game_object" | "area_trigger"
  | "faction" | "achievement" | "instance" | "ui_map" | "world_map" | "journal_instance" | "challenge_map" | "map_floor" | "encounter";
export type WorldNamespace = "retail" | "classic-era" | "classic-progression" | "classic-seasonal" | "classic-anniversary" | `custom:${string}`;
export type WorldValue = null | boolean | number | string | WorldValue[] | { [key: string]: WorldValue };
export interface WorldEntityKey { namespace: WorldNamespace; kind: WorldEntityKind; native_id: number }
export interface WorldSelector {
  namespace: WorldNamespace;
  kind: WorldEntityKind;
  native_id: number | null;
  name: string | null;
  predicates: string[] | null;
}
export type WorldCondition = { op: "true" | "false" | "unknown" }
  | { op: "and" | "or"; args: WorldCondition[] }
  | { op: "not"; arg: WorldCondition }
  | { op: "fact"; scope: "character" | "account" | "context"; key: string; cmp: "eq" | "gte" | "in"; value: WorldValue }
  | { op: "quest_completed" | "quest_active" | "unlock"; scope: "character" | "account"; entity: WorldEntityKey };
export interface WorldSourceRevision {
  provider: string; revision: string; source_version: GameVersion; url: string; retrieved_at: string;
  license: { code: string | null; data: string | null; images: string | null; distribution: "permitted" | "local_only" | "prohibited" | "unknown" };
  third_party: { provider: string; license: string; note: string }[];
  note: string;
}
export interface WorldAssertion {
  assertion_sha256: string; assertion_canonical: string; source_canonical: string;
  source_revision: WorldSourceRevision; entity: WorldEntityKey; predicate: string;
  state: "known" | "unknown" | "unsupported" | "not_present"; value: WorldValue;
  source_sha256: string; artifact_sha256: string | null; locator: string; observed_at: string;
  condition: WorldCondition; verification: "reference_only" | "source_verified" | "locally_verified"; applicability: GameDataProof[];
}
export interface WorldField {
  status: "known" | "unknown" | "unsupported" | "not_present" | "conflict";
  value: WorldValue; assertion_ids: string[]; assertions: WorldAssertion[];
}
export interface WorldLookupResult {
  schema_version: 2; world_pack_sha256: string; rule_version: string; requested_version: GameVersion;
  status: "found" | "not_found" | "version_unknown" | "ambiguous" | "conflict" | "references";
  entities: { key: WorldEntityKey; fields: Record<string, WorldField> }[];
  automatic_action_eligible: false; applicable_to_requested_client: boolean;
}
export interface WorldBatchResult {
  schema_version: 2; world_pack_sha256: string; results: WorldLookupResult[]; automatic_action_eligible: false;
}
export interface WorldDataClientOptions {
  repositoryDirectory: string; worldPackDirectory: string; worldPackSha256: string; pythonExecutable?: string; timeoutMs?: number;
}
type Operation = "lookup" | "references";
type WorldReply = { schema_version: 2; ok: true; result: WorldBatchResult } | { schema_version: 2; ok: false; error: string };
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** JSON numbers cannot represent every SQLite int64 ID; reject instead of rounding an identity. */
function safeEntityIds(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(safeEntityIds);
  const record = value as Record<string, unknown>;
  return (record.native_id === undefined || record.native_id === null || Number.isSafeInteger(record.native_id)) && Object.values(record).every(safeEntityIds);
}
function parseReply(text: string): unknown {
  const parts = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (const [index, token] of parts.entries()) {
    if (token === "{") stack.push(new Set()); else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (parts[index + 1] === ":" && token.startsWith('"')) {
      const keys = stack.at(-1); const key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) throw new Error("duplicate_key"); keys.add(key);
    }
    if (stack.length > 64) throw new Error("response_depth");
  }
  return JSON.parse(text) as unknown;
}
/** Hash Python's exact persisted UTF-8 bytes before comparing their parsed JSON values. */
function assertAssertionBytes(record: WorldAssertion): void {
  const { assertion_canonical, source_canonical, assertion_sha256, source_revision, ...assertion } = record;
  const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
  if (digest(assertion_canonical) !== assertion_sha256 || digest(source_canonical) !== record.source_sha256 ||
    !same(parseReply(assertion_canonical), assertion) || !same(parseReply(source_canonical), source_revision)) throw new Error("assertion_source_bytes");
}

/** 固定世界包 SHA 的离线只读查询；参考资料不授权游戏输入。 */
export class WorldDataClient {
  private readonly repository: string;
  readonly worldPackDirectory: string;
  readonly worldPackSha256: string;
  private readonly python: string;
  private readonly timeout: number;
  private readonly validateRequest: ValidateFunction;
  private readonly validateReply: ValidateFunction;
  constructor(options: WorldDataClientOptions) {
    this.repository = resolve(options.repositoryDirectory);
    this.worldPackDirectory = resolve(options.worldPackDirectory);
    this.worldPackSha256 = options.worldPackSha256;
    this.python = options.pythonExecutable ?? "/usr/bin/python3";
    this.timeout = options.timeoutMs ?? 5000;
    if (!/^[a-f0-9]{64}$/.test(this.worldPackSha256)) throw new Error("world_data_pack_sha256_invalid");
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 100 || this.timeout > 30_000) throw new Error("world_data_timeout_invalid");
    const ajv = new Ajv({ strict: true, allErrors: false });
    ajv.addSchema(JSON.parse(readFileSync(resolve(this.repository, "game_database/schema-v1.json"), "utf8")) as object);
    ajv.addSchema(JSON.parse(readFileSync(resolve(this.repository, "game_database/schema-v2.json"), "utf8")) as object);
    this.validateRequest = ajv.compile({ $ref: "urn:wow-jev:world-data-v2#/$defs/request" });
    this.validateReply = ajv.compile({ $ref: "urn:wow-jev:world-data-v2#/$defs/response" });
  }
  lookup(version: GameVersion, selectors: readonly WorldSelector[], signal?: AbortSignal): Promise<WorldBatchResult> {
    return this.request("lookup", version, selectors, signal);
  }
  references(version: GameVersion, selectors: readonly WorldSelector[], signal?: AbortSignal): Promise<WorldBatchResult> {
    return this.request("references", version, selectors, signal);
  }
  private async request(operation: Operation, version: GameVersion, selectors: readonly WorldSelector[], signal?: AbortSignal): Promise<WorldBatchResult> {
    if (signal?.aborted) throw new Error("world_data_cancelled");
    const request = { schema_version: 2, operation, directory: this.worldPackDirectory, world_pack_sha256: this.worldPackSha256, version, selectors };
    if (!this.validateRequest(request) || !safeEntityIds(request)) throw new Error("world_data_request_invalid");
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 65_536) throw new Error("world_data_request_limit");
    // Freeze both transport and response bindings before the first await or caller mutation.
    const frozen = JSON.parse(input) as typeof request;
    return new Promise((accept, reject) => {
      const child = spawn(this.python, ["-B", "-m", "game_database.v2.bridge"], { cwd: this.repository, stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } });
      let output = "", bytes = 0, stderrBytes = 0, settled = false;
      const timer = setTimeout(() => stop("world_data_timeout"), this.timeout);
      const onAbort = (): void => stop("world_data_cancelled");
      const finish = (error?: Error, value?: WorldBatchResult): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else accept(value!);
      };
      const stop = (reason: string): void => { child.kill("SIGKILL"); finish(new Error(reason)); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { stop("world_data_cancelled"); return; }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4 * 1024 * 1024) { stop("world_data_response_limit"); return; }
        output += chunk;
      });
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 65_536) stop("world_data_stderr_limit"); });
      child.stdin.on("error", () => stop("world_data_pipe_failed"));
      child.on("error", () => finish(new Error("world_data_process_failed")));
      child.on("close", (code) => {
        if (settled) return;
        let reply: unknown;
        try {
          reply = parseReply(output);
          if (!this.validateReply(reply) || !safeEntityIds(reply)) throw new Error("schema");
        } catch { finish(new Error("world_data_response_invalid")); return; }
        const response = reply as WorldReply;
        if (code !== 0 || !response.ok) { finish(new Error(`world_data_query_failed:${response.ok ? "worker_failed" : response.error}`)); return; }
        try { this.assertBinding(response.result, frozen.operation, frozen.version, frozen.selectors); }
        catch { finish(new Error("world_data_response_binding")); return; }
        finish(undefined, response.result);
      });
      child.stdin.end(input);
    });
  }
  private assertBinding(batch: WorldBatchResult, operation: Operation, version: GameVersion, selectors: readonly WorldSelector[]): void {
    if (batch.world_pack_sha256 !== this.worldPackSha256 || batch.results.length !== selectors.length) throw new Error("batch");
    for (const [index, result] of batch.results.entries()) {
      const selector = selectors[index]!;
      if (result.world_pack_sha256 !== this.worldPackSha256 || !same(result.requested_version, version) ||
        result.applicable_to_requested_client !== (operation === "lookup") || operation === "lookup" && result.status === "references" ||
        operation === "references" && ["found", "conflict", "version_unknown"].includes(result.status) ||
        ["not_found", "version_unknown"].includes(result.status) && result.entities.length !== 0 ||
        result.status === "ambiguous" && result.entities.length < 2 ||
        ["found", "conflict", "references"].includes(result.status) && result.entities.length !== 1) throw new Error("result");
      if (result.entities.length > 0) {
        const status = result.entities.length > 1 ? "ambiguous" : operation === "references" ? "references" :
          Object.values(result.entities[0]!.fields).some(field => field.status === "conflict") ? "conflict" : "found";
        if (result.status !== status) throw new Error("result_status");
      }
      const keys = new Set<string>();
      for (const entity of result.entities) {
        if (entity.key.namespace !== selector.namespace || entity.key.kind !== selector.kind ||
          selector.native_id !== null && entity.key.native_id !== selector.native_id || keys.has(canonical(entity.key))) throw new Error("entity");
        keys.add(canonical(entity.key));
        if (selector.predicates && !same(Object.keys(entity.fields).sort(), [...new Set(selector.predicates)].sort())) throw new Error("predicates");
        for (const [predicate, field] of Object.entries(entity.fields)) {
          field.assertions.forEach(assertAssertionBytes);
          const active = field.assertions.filter(a => same(a.condition, { op: "true" }) && (!["name", "alias", "description"].includes(predicate) || version.locale !== null && a.source_revision.source_version.locale === version.locale));
          const values = new Set(active.map(a => canonical({ state: a.state, value: a.value })));
          const status = active.length === 0 ? "unknown" : values.size > 1 ? "conflict" : active[0]!.state;
          const adopted = status === "conflict" ? [] : active.map(a => a.assertion_sha256).sort();
          if (field.status !== status || !same(field.value, status === "known" ? active[0]!.value : null) ||
            !same(field.assertion_ids, adopted) || new Set(field.assertions.map(a => a.assertion_sha256)).size !== field.assertions.length || field.assertions.some(a =>
              !same(a.entity, entity.key) || a.predicate !== predicate || operation === "lookup" && !a.applicability.some(p => same(p.version, version)))) throw new Error("assertion");
        }
      }
    }
  }
}
