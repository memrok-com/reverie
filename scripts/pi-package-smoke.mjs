import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { MemoryClient } from '../.work/pi-test/memory-client.mjs';
import { executablePath } from '../.work/pi-test/service.mjs';
const report = JSON.parse(await readFile('validation/pi-package.json', 'utf8'));
const archive = resolve(report.archive), root = resolve('.work/pi-package', randomUUID()), cwd = join(root, 'project'), agentDir = join(root, 'agent');
await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), report.sha256);
const extracted = spawnSync('tar', ['-xf', archive, '-C', root], { encoding: 'utf8', windowsHide: true });
assert.equal(extracted.status, 0, extracted.stderr);
const packageDir = join(root, 'package'), manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@memrok-com/reverie-pi'); assert.ok(manifest.pi.extensions.length === 1);
assert.equal(manifest.dependencies, undefined);
assert.equal(manifest.license, 'Apache-2.0');
for (const name of ['LICENSE', 'NOTICE']) {
  assert.equal(await readFile(join(packageDir, name), 'utf8'), await readFile(name, 'utf8'), `${name} must survive packaging unchanged`);
}
const client = new MemoryClient({ executable: executablePath(packageDir), characterId: 'portable', database: join(root, 'memory.sqlite'),
  readSource: async () => { throw new Error('Unexpected source access.'); }, infer: async () => { throw new Error('Unexpected inference.'); } });
try { assert.equal((await client.request('ping')).runtime, 'rust'); await client.request('forget', { episodeId: 'absent' }); }
finally { await client.close(); }
const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
const install = spawnSync(process.execPath, [cli, 'install', '--local', packageDir], { cwd, env, encoding: 'utf8', windowsHide: true });
assert.equal(install.status, 0, install.stderr);
const settings = JSON.parse(await readFile(join(cwd, '.pi/settings.json'), 'utf8'));
assert.ok(JSON.stringify(settings.packages).includes('package'));
const rpc = new RpcClient({ cliPath: cli, cwd, env, args: ['--offline', '--no-tools', '--approve'] });
try {
  await rpc.start();
  const commands = await rpc.getCommands();
  assert.ok(commands.some(command => command.name === 'reverie'), JSON.stringify(commands));
  assert.doesNotMatch(rpc.getStderr(), /Extension.*error|Failed to load|Cannot find/);
} finally { await rpc.stop(); }
await writeFile('validation/pi-package-smoke.json', JSON.stringify({ version: manifest.version, piVersion: '1.3.0',
  checks: ['archive hash and contents', 'Apache-2.0 metadata and bundled LICENSE/NOTICE', 'relocated native engine', 'model-free deletion', 'Pi local package install', 'real Pi RPC startup and command discovery'],
  installedFromExtractedArchive: true }, null, 2) + '\n');
console.log('Relocated archive, native engine, local package install and real Pi command loading passed.');
