import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('.work/pi-test', { recursive: true });
for (const name of ['extension', 'catalog', 'source', 'service', 'memory-client', 'story-backup']) {
  await build({ entryPoints: [`pi/src/${name}.ts`], outfile: `.work/pi-test/${name}.mjs`, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['@earendil-works/pi-tui'] });
}
