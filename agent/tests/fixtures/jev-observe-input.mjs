import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.WOW_JEV_TEST_NATIVE_TRACE, JSON.stringify({ client: 'input', args }) + '\n');
if (args.length !== 1 || args[0] !== 'list') {
  process.stderr.write('observe_test_forbidden_input_session\n');
  process.exitCode = 86;
} else {
  process.stdout.write(JSON.stringify({ hwnd: '0xabc', pid: 42, proc: 'Wow', focused: false }) + '\n');
}
