import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sanitizeTestReport } from './lib/validation-report.mjs';
import { nativeEnginePath } from './lib/native-toolchain.mjs';
import { mkdirSync } from 'node:fs';

const root = resolve(import.meta.dirname, '..');
const reportDirectory = process.env.REVERIE_VALIDATION_DIR ?? 'validation';
mkdirSync(resolve(root, reportDirectory), { recursive: true });
const reportPath = `${reportDirectory}/native-tests.xml`;
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  const report = args.find(arg => arg.startsWith('--test-reporter-destination=') && arg !== '--test-reporter-destination=stdout');
  if (report) sanitizeTestReport(report.slice('--test-reporter-destination='.length));
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['scripts/build-pi-tests.mjs']);
run(['scripts/cargo.mjs', 'test', '--locked']);
run(['scripts/cargo.mjs', 'build', '--release', '--locked']);
run(['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${reportPath}`,
  'test/native/*.test.mjs', 'test/process.test.mjs'],
{ ...process.env, REVERIE_TEST_ENGINE: nativeEnginePath() });
console.log(`Rust unit checks and native release integration checks passed. See ${reportPath}.`);
