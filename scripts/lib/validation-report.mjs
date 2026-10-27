import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// Keep committed reports independent of the checkout location and account name.
export function sanitizeTestReport(path) {
  const root = resolve(import.meta.dirname, '../..');
  const report = readFileSync(path, 'utf8')
    .replaceAll(root + sep, '')
    .replaceAll(root.replaceAll('\\', '/') + '/', '')
    .replace(/file="([^"]+)"/g, (_, file) => `file="${file.replaceAll('\\', '/')}"`);
  writeFileSync(path, report);
}
