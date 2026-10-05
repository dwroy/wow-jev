import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import type { EntitySelector, GameBranch, GameDataResult, GameDataStats, GameVersion } from "./types.js";

export * from "./types.js";
export interface GameDataClientOptions {
  repositoryDirectory: string;
  databasePath: string;
  pythonExecutable?: string;
  timeoutMs?: number;
}

/** Reads only. Public reference assertions never bypass live perception gates. */
export class GameDataClient {
  private readonly repository: string;
  private readonly database: string;
  private readonly python: string;
  private readonly timeout: number;
  private readonly validate: ValidateFunction;

  constructor(options: GameDataClientOptions) {
    this.repository = resolve(options.repositoryDirectory);
    this.database = resolve(options.databasePath);
    this.python = options.pythonExecutable ?? "/usr/bin/python3";
    this.timeout = options.timeoutMs ?? 5000;
    if (!Number.isInteger(this.timeout) || this.timeout < 100 || this.timeout > 30_000) throw new Error("game_data_timeout_invalid");
    const schema: unknown = JSON.parse(readFileSync(resolve(this.repository, "game_database/schema-v1.json"), "utf8"));
    this.validate = new Ajv({ strict: true, allErrors: false }).compile(schema as object);
  }

  async lookup(version: GameVersion, selector: EntitySelector, signal?: AbortSignal): Promise<GameDataResult> {
    return this.request("lookup", { version, kind: selector.kind, entity_id: selector.entity_id ?? null, name: selector.name ?? null }, signal) as Promise<GameDataResult>;
  }

  async references(branch: GameBranch, locale: string, selector: EntitySelector, signal?: AbortSignal): Promise<GameDataResult> {
    return this.request("references", { branch, locale, kind: selector.kind, entity_id: selector.entity_id ?? null, name: selector.name ?? null }, signal) as Promise<GameDataResult>;
  }

  async stats(signal?: AbortSignal): Promise<GameDataStats> {
    return this.request("stats", {}, signal) as Promise<GameDataStats>;
  }

  private async request(operation: string, query: object, signal?: AbortSignal): Promise<GameDataResult | GameDataStats> {
    if (signal?.aborted) throw new Error("game_data_cancelled");
    const input = JSON.stringify({ schema_version: 1, operation, database: this.database, query });
    if (Buffer.byteLength(input) > 65_536) throw new Error("game_data_request_limit");
    return new Promise((accept, reject) => {
      const child = spawn(this.python, ["-B", "-m", "game_database.bridge"], {
        cwd: this.repository, stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
      });
      let output = "", bytes = 0, settled = false;
      const timer = setTimeout(() => stop("game_data_timeout"), this.timeout);
      const onAbort = (): void => stop("game_data_cancelled");
      const finish = (error?: Error, value?: GameDataResult | GameDataStats): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else accept(value!);
      };
      const stop = (message: string): void => { child.kill("SIGKILL"); finish(new Error(message)); };
      signal?.addEventListener("abort", onAbort, { once: true });
      // stdout decoding must preserve multibyte names across chunk boundaries.
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4 * 1024 * 1024) { stop("game_data_response_limit"); return; }
        output += chunk;
      });
      child.stderr.resume();
      child.stdin.on("error", () => stop("game_data_pipe_failed"));
      child.on("error", () => finish(new Error("game_data_process_failed")));
      child.on("close", (code) => {
        if (settled) return;
        let reply: unknown;
        try { reply = JSON.parse(output); } catch { finish(new Error("game_data_response_invalid")); return; }
        if (!this.validate(reply)) { finish(new Error("game_data_response_invalid")); return; }
        const response = reply as { ok: boolean; result?: GameDataResult | GameDataStats; error?: string };
        if (code !== 0 || !response.ok || !response.result) { finish(new Error(`game_data_query_failed:${response.error ?? "worker_failed"}`)); return; }
        finish(undefined, response.result);
      });
      child.stdin.end(input);
    });
  }
}
