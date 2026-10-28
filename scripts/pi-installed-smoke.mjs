// Explicit post-install check of an existing Pi. It never requests a model response.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RpcClient } from '@earendil-works/pi-coding-agent';

const cliPath = process.argv[2];
assert.ok(cliPath, 'Pass the installed Pi dist/bundle/cli.js path.');
const rpc = new RpcClient({ cliPath: resolve(cliPath), cwd: process.cwd(),
  args: ['--offline', '--no-tools', '--approve'] });
try {
  await rpc.start();
  const commands = await rpc.getCommands();
  assert.ok(commands.some(command => command.name === 'reverie'), 'Reverie command is missing from installed Pi.');
  assert.doesNotMatch(rpc.getStderr(), /Extension.*error|Failed to load|Cannot find/);
  await writeFile('validation/pi-installed.json', JSON.stringify({ version: JSON.parse(await readFile('dist/reverie-pi/package.json', 'utf8')).version, piVersion: '1.3.0',
    checks: ['Existing user Pi installation discovers registered Reverie package', 'Reverie command is available over RPC', 'No model generation requested'],
    packageDirectory: 'dist/reverie-pi' }, null, 2) + '\n');
  console.log('Existing Pi installation loads Reverie successfully. No model response was requested.');
} finally { await rpc.stop(); }
