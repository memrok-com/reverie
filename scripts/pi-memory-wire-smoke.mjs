// Verify actual HTTP roles through the packaged extension and a real Pi CLI.
// Only an isolated home, authored fixture and credential-free loopback server are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { Catalog } from '../.work/pi-test/catalog.mjs';
import { MemoryClient } from '../.work/pi-test/memory-client.mjs';
import { executablePath } from '../.work/pi-test/service.mjs';
import { reflection } from '../test/fixtures/subjective.mjs';

const root = resolve('.work/pi-wire', randomUUID()), cwd = join(root, 'Mara'), agentDir = join(root, 'agent');
await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
const home = join(agentDir, 'reverie'), catalog = new Catalog(home);
const character = catalog.create('Mara', 'You are Mara, proud and wary.'); catalog.bind(cwd, character.id); catalog.close();
const chatRequests = [];
const server = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), content = body.messages.findLast(item => item.role === 'user').content;
    const text = typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    let input; try { input = JSON.parse(text); } catch {}
    if (!input?.episode) chatRequests.push(body);
    const answer = input?.episode ? JSON.stringify(reflection({ input })) : 'I take the lantern and smile.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
      created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    chunk({ role: 'assistant', content: answer }); chunk({}, 'stop'); res.end('data: [DONE]\n\n');
  } catch { res.writeHead(500); res.end('Fixture request failed.'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl,
  apiKey: 'local-fixture', models: [{ id: 'fixture', reasoning: false, contextWindow: 64000, maxTokens: 4096 }] } } }));
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, cacheWarming: { mode: 'off' }, telemetry: { enabled: false } }));
const packageDir = resolve('dist/reverie-pi');
const observer = new MemoryClient({ executable: executablePath(packageDir), characterId: character.id, database: join(home, 'memory.sqlite'),
  readSource: async () => { throw new Error('Observer never reads source.'); }, infer: async () => { throw new Error('Observer never infers.'); } });
const rpc = new RpcClient({ cliPath: process.argv[2] ?? resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), cwd,
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' }, provider: 'fixture', model: 'fixture',
  args: ['--offline', '--no-tools', '--approve', '-e', packageDir] });
let settled = 0; rpc.onEvent(event => { if (event.type === 'agent_settled') settled++; });
async function until(check) {
  const end = Date.now() + 15000;
  while (!await check()) { if (Date.now() > end) throw new Error('Timed out waiting for Pi HTTP memory check.'); await delay(50); }
}
async function play(text) { const before = settled; await rpc.prompt(text); await until(() => settled > before); }
try {
  await rpc.start();
  await rpc.prompt('/reverie when 2010-01-01 The lighthouse');
  await play('I offer a blue lantern.');
  assert.deepEqual(chatRequests[0].messages.map(item => item.role), ['system', 'user']);
  assert.doesNotMatch(JSON.stringify(chatRequests[0]), /No long-term recollections|Private character memory/);
  await rpc.prompt('/reverie memorize');
  await until(async () => (await observer.request('status')).episodes.some(item => item.included));
  await rpc.newSession(); await rpc.prompt('/reverie when 2015-01-01 Later');
  await play('Do you remember the lighthouse?');
  const recalled = chatRequests[1].messages;
  assert.deepEqual(recalled.map(item => item.role), ['system', 'user']);
  assert.match(recalled[0].content, /Private character memory/);
  assert.match(recalled[0].content, /I remember The lighthouse/);
  assert.equal(typeof recalled[1].content === 'string' ? recalled[1].content : recalled[1].content.map(item => item.text).join('\n'), 'Do you remember the lighthouse?');
  await rpc.prompt('/reverie off'); await play('Stay here with me.');
  assert.doesNotMatch(chatRequests[2].messages[0].content, /Private character memory|I remember The lighthouse/);
  assert.doesNotMatch(rpc.getStderr(), /Failed to load|Cannot find/);
  await writeFile('validation/pi-memory-wire.json', JSON.stringify({ version: '0.3.0', piVersion: '1.3.0',
    checks: ['Real Pi CLI and packaged extension generate through an OpenAI-compatible HTTP fixture',
      'Empty recall sends only system persona and real user dialogue', 'Nonempty recall is sent in the system role',
      'Latest user message stays last and unchanged', 'Memory off removes private recall context'],
    userDataUsed: false, externalModelUsed: false }, null, 2) + '\n');
  console.log('Actual Pi HTTP payload checks passed: empty recall omitted, real memory in system role, player message last.');
} finally {
  await rpc.stop(); await observer.close();
  server.closeAllConnections(); await new Promise(done => server.close(done));
}
