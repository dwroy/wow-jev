import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { NativeInputClient } from './client.js';

const MAX_CONTROL_BYTES = 4096;
function sessionSocket(sessionId: string, dir: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) throw new Error('Invalid session UUID (canonical lowercase required)');
  return join(dir, `${sessionId}.sock`);
}
export function defaultSessionDir(): string {
  if (process.platform !== 'linux' || !process.getuid) throw new Error('Persistent input control requires WSL/Linux');
  return join(tmpdir(), `wow-jev-input-${process.getuid()}`);
}

/** A same-user socket allows panic from another WSL terminal without a second executor. */
export async function openSessionControl(client: NativeInputClient, dir = defaultSessionDir()) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('Unsafe session directory');
  await chmod(dir, 0o700);
  const path = sessionSocket(client.sessionId, dir);
  const server = createServer((socket) => {
    let bytes = 0; let buffer = ''; let handled = false;
    const decoder = new StringDecoder('utf8');
    socket.setTimeout(4000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_CONTROL_BYTES) { socket.destroy(); return; }
      buffer += decoder.write(chunk);
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      handled = true;
      void (async () => {
        try {
          const data: unknown = JSON.parse(buffer.slice(0, end));
          if (typeof data !== 'object' || data === null || Object.keys(data).length !== 1 || !('op' in data) || typeof data.op !== 'string' ||
            !['release_all', 'cancel', 'status'].includes(data.op)) throw new Error('Invalid control command');
          const receipt = data.op === 'release_all' ? await client.releaseAll() : data.op === 'cancel' ? await client.cancel() : await client.status();
          socket.end(`${JSON.stringify(receipt)}\n`);
        } catch (error) { socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : 'control_failed' })}\n`); }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  server.on('error', () => {});
  await chmod(path, 0o600);
  return {
    path,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    },
  };
}

export function requestSessionControl(sessionId: string, op: 'release_all' | 'cancel' | 'status', dir = defaultSessionDir()): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sessionSocket(sessionId, dir));
    let buffer = ''; let size = 0; let settled = false; const decoder = new StringDecoder('utf8');
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('panic_control_timeout: release unconfirmed')), 4000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ op })}\n`));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 65536) { finish(new Error('control_output_limit')); return; }
      buffer += decoder.write(chunk);
      const end = buffer.indexOf('\n');
      if (end >= 0) { try { finish(undefined, JSON.parse(buffer.slice(0, end))); } catch { finish(new Error('invalid_control_response')); } }
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => { if (!settled) finish(new Error('control_disconnected: release unconfirmed')); });
  });
}
