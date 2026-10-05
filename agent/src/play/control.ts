import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { PlayStatus } from './types.js';

export interface PlayControlTarget {
  cancel(reason?: string): Promise<{ release: 'confirmed' | 'unconfirmed' }>;
  status(): PlayStatus;
}
export function playControlDir(): string {
  if (process.platform !== 'linux' || !process.getuid) throw new Error('play_control_requires_wsl');
  return join(tmpdir(), `wow-jev-play-${process.getuid()}`);
}
function controlPath(session: string, dir: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session)) throw new Error('invalid_play_session');
  return join(dir, `${session}.sock`);
}

/** Cancellation belongs to the plan, including gaps between native actions. */
export async function openPlayControl(target: PlayControlTarget, session: string, dir = playControlDir()) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('unsafe_play_control_dir');
  await chmod(dir, 0o700);
  const path = controlPath(session, dir);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let bytes = 0; let buffer = ''; let handled = false;
    const decoder = new StringDecoder('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      bytes += chunk.byteLength;
      if (bytes > 4096) { socket.destroy(); return; }
      buffer += decoder.write(chunk);
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      handled = true;
      void (async () => {
        try {
          const message: unknown = JSON.parse(buffer.slice(0, end));
          if (typeof message !== 'object' || message === null || Object.keys(message).length !== 1 || !('op' in message) ||
              typeof message.op !== 'string' || !['cancel', 'status'].includes(message.op)) throw new Error('invalid_play_control_command');
          const result = message.op === 'cancel' ? await target.cancel('external_control') : { status: target.status() };
          socket.end(`${JSON.stringify(result)}\n`);
        } catch (error) { socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : 'play_control_failed' })}\n`); }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  server.on('error', () => {});
  await chmod(path, 0o600);
  return { path, close: async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });
    try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } };
}

export function requestPlayControl(session: string, op: 'cancel' | 'status', dir = playControlDir()): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlPath(session, dir));
    let bytes = 0; let buffer = ''; let settled = false;
    const decoder = new StringDecoder('utf8');
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('play_control_timeout_release_unconfirmed')), 5000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ op })}\n`));
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 65536) { finish(new Error('play_control_output_limit')); return; }
      buffer += decoder.write(chunk);
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        try { finish(undefined, JSON.parse(buffer.slice(0, end))); } catch { finish(new Error('invalid_play_control_response')); }
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => { if (!settled) finish(new Error('play_control_disconnected_release_unconfirmed')); });
  });
}
