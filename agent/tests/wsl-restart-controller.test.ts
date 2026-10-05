import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { consumeToken } from '../../tools/wsl_restart_controller.js';

test('durable controller token is consumed once and preserves the original tombstone', async () => {
  const root = await mkdtemp(join(tmpdir(),'wow-restart-token-')); const path=join(root,'token.consumed');
  assert.equal(consumeToken(path,'first-token'),true);
  assert.equal(consumeToken(path,'second-token'),false);
  assert.equal(await readFile(path,'utf8'),'first-token\n');
});

test('replayed old token refuses before importing a missing production client or spawning any executor', async () => {
  const root=await mkdtemp(join(tmpdir(),'wow-restart-replay-'));
  const token='11111111-1111-4111-8111-111111111111'; await writeFile(join(root,token+'.consumed'),token+'\n');
  const config=join(root,'config.json'); await writeFile(config,JSON.stringify({mode:'old',token,session_id:token,hwnd:'0x123',pid:1,native_wsl:'/nonexistent-native',native_windows:'C:\\nonexistent-native',out_wsl:root,repo_wsl:'/nonexistent-repo',schema_wsl:'/nonexistent-schema'}));
  const executable=resolve('node_modules/.bin/tsx');
  const result=spawnSync(executable,[resolve('../tools/wsl_restart_controller.ts'),config],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,3); assert.match(result.stderr,/controller_token_already_consumed/);
  assert.equal(await readFile(join(root,token+'.consumed'),'utf8'),token+'\n');
});


test('changing mode cannot revive a consumed old controller token', async () => {
  const root=await mkdtemp(join(tmpdir(),'wow-restart-cross-mode-'));
  const token='11111111-1111-4111-8111-111111111111'; await writeFile(join(root,token+'.consumed'),token+'\n');
  const config=join(root,'config.json'); await writeFile(config,JSON.stringify({mode:'fresh',token,session_id:'22222222-2222-4222-8222-222222222222',hwnd:'0x123',pid:1,native_wsl:'/nonexistent-native',native_windows:'C:\\nonexistent-native',out_wsl:root,repo_wsl:'/nonexistent-repo',schema_wsl:'/nonexistent-schema'}));
  const result=spawnSync(resolve('node_modules/.bin/tsx'),[resolve('../tools/wsl_restart_controller.ts'),config],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,3); assert.match(result.stderr,/controller_token_already_consumed/);
});
