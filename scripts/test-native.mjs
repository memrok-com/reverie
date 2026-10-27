import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sanitizeTestReport } from './lib/validation-report.mjs';

const root = resolve(import.meta.dirname, '..');
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  const report = args.find(arg => arg.startsWith('--test-reporter-destination='));
  if (report) sanitizeTestReport(report.slice('--test-reporter-destination='.length));
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['scripts/build-pi-tests.mjs']);
run(['scripts/cargo.mjs', 'test', '--locked']);
run(['scripts/cargo.mjs', 'build', '--release', '--locked']);
run(['--test', '--test-reporter=junit', '--test-reporter-destination=validation/native-tests.xml',
  'test/native/*.test.mjs', 'test/process.test.mjs'],
{ ...process.env, REVERIE_TEST_ENGINE: resolve(root, 'engine/target/x86_64-pc-windows-gnu/release/reverie-engine.exe') });
console.log('Rust unit checks and native release integration checks passed. See validation/native-tests.xml.');
