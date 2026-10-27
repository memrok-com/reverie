import { spawnSync } from 'node:child_process';
import { sanitizeTestReport } from './lib/validation-report.mjs';
for (const args of [
  ['node_modules/typescript/bin/tsc', '-p', 'pi/tsconfig.json'],
  ['scripts/test-native.mjs'],
  ['--test', '--test-reporter=junit', '--test-reporter-destination=validation/pi-tests.xml', 'test/pi/*.test.mjs'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  const report = args.find(arg => arg.startsWith('--test-reporter-destination='));
  if (report) sanitizeTestReport(report.slice('--test-reporter-destination='.length));
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Native engine and real Pi session acceptance checks passed.');
