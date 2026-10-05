import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPlayControl, requestPlayControl } from '../src/play/control.js';

test('cross-terminal cancel latches plan stop even with no native action active', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wow-play-control-'));
  const session = randomUUID(); let cancelled = false; let calls = 0;
  const control = await openPlayControl({
    status: () => ({ state: 'running', cancelled, plan: { id: 'p', revision: 1 } }),
    cancel: async () => { calls++; cancelled = true; return { release: 'confirmed' }; },
  }, session, dir);
  try {
    assert.deepEqual(await requestPlayControl(session, 'status', dir), { status: { state: 'running', cancelled: false, plan: { id: 'p', revision: 1 } } });
    assert.deepEqual(await requestPlayControl(session, 'cancel', dir), { release: 'confirmed' });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  } finally { await control.close(); await rm(dir, { recursive: true }); }
});

test('control rejects array operators and extra keys without cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wow-play-control-'));
  const session = randomUUID(); let calls = 0;
  const control = await openPlayControl({
    status: () => ({ state: 'idle', cancelled: false, plan: null }),
    cancel: async () => { calls++; return { release: 'unconfirmed' }; },
  }, session, dir);
  const raw = (message: unknown) => new Promise<{ error?: string }>((resolve, reject) => {
    const socket = createConnection(control.path); let text = '';
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('test_socket_timeout')); });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('end', () => { socket.destroy(); resolve(JSON.parse(text) as { error?: string }); });
  });
  try {
    assert.equal((await raw({ op: ['cancel'] })).error, 'invalid_play_control_command');
    assert.equal((await raw({ op: 'cancel', extra: true })).error, 'invalid_play_control_command');
    assert.equal(calls, 0);
  } finally { await control.close(); await rm(dir, { recursive: true }); }
});

test('shutdown destroys a half-open client that keeps writing after its response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wow-play-control-'));
  const control = await openPlayControl({
    status: () => ({ state: 'stopped', cancelled: false, plan: null }),
    cancel: async () => ({ release: 'confirmed' }),
  }, randomUUID(), dir);
  const socket = createConnection({ path: control.path, allowHalfOpen: true });
  socket.on('error', () => {});
  let closed = false; let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('data', () => resolve());
      socket.on('connect', () => socket.write('{"op":"status"}\n'));
    });
    timer = setInterval(() => { socket.write('x'); }, 20);
    await Promise.race([control.close(), new Promise<never>((_, reject) => {
      const deadline = setTimeout(() => reject(new Error('socket_prevented_shutdown')), 1000);
      deadline.unref();
    })]);
    closed = true;
  } finally {
    if (timer) clearInterval(timer);
    socket.destroy();
    if (!closed) await control.close();
    await rm(dir, { recursive: true });
  }
});
