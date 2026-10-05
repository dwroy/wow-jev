import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
appendFileSync(process.env.WOW_JEV_TEST_NATIVE_TRACE, JSON.stringify({ client: 'eye', args }) + '\n');
// Reuse the existing read-only eye mock's sample/artifact/EOF protocol, including real exported file hashes.
process.argv = [process.argv[0], fileURLToPath(new URL('./mock-eye.mjs', import.meta.url)),
  'steady', process.env.WOW_JEV_TEST_NATIVE_EXPORT, ...args];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const message = JSON.parse(String(chunk));
  if (message.window) message.window.focused = false;
  return write(JSON.stringify(message) + '\n', ...rest);
};
await import('./mock-eye.mjs');
