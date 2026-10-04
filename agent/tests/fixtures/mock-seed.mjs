import readline from 'node:readline';
const fields = {
  'player.name': { status: 'known', value: '测试角色', confidence: 0.8 },
  'player.level': { status: 'known', value: 10, confidence: 0.8 },
  'target.present': { status: 'known', value: false, confidence: 0.8 },
  'target.name': { status: 'unknown', value: null, confidence: 0 },
  'player.in_combat': { status: 'known', value: false, confidence: 0.8 },
  'scene.summary': { status: 'known', value: '测试画面', confidence: 0.8 },
  'ui.inventory_open': { status: 'known', value: true, confidence: 0.8 },
};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  setTimeout(() => process.stdout.write(JSON.stringify({ type: 'seed_result', id: request.id, status: 'ok', model: 'mock', prompt_sha256: 'a'.repeat(64),
    fields, usage: { input_tokens: 10, output_tokens: 10 }, elapsed_ms: 50, prompt_version: 'eye-retail-v1', schema_version: 1, raw_text: 'mock response' }) + '\n'), 50);
});
process.stdin.on('end', () => process.exit(0));
