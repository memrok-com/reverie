// Local, credential-free provider for exercising the installed Pi terminal and package.
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Catalog } from '../.work/pi-test/catalog.mjs';
import { reflection } from '../test/fixtures/subjective.mjs';
const root = resolve('.work/pi-ui'), cwd = join(root, 'Mara'), agentDir = join(root, 'agent');
await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
const catalog = new Catalog(join(agentDir, 'reverie'));
const character = catalog.characters()[0] ?? catalog.create('Mara', 'You are Mara, proud and slow to trust. Speak naturally in first person.');
catalog.bind(cwd, character.id); catalog.close();
let replies = 0; const requests = [];
const server = createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body); await writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2));
    const last = body.messages?.findLast(item => item.role === 'user');
    const user = typeof last?.content === 'string' ? last.content : last?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    let input; try { input = JSON.parse(user); } catch {}
    const text = input?.episode ? JSON.stringify(reflection({ input })) : `Alternative ${++replies}: I take the blue lantern and look toward the lighthouse.`;
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      chunk({ role: 'assistant', content: '' }); chunk({ content: text }); chunk({}, 'stop'); res.end('data: [DONE]\n\n');
    } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'fixture', choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })); }
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture',
  models: [{ id: 'fixture', name: 'Local test model', contextWindow: 64000, maxTokens: 4096, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', thinkingLevel: 'off', compaction: { enabled: false }, cacheWarming: { mode: 'off' }, telemetry: { enabled: false } }));
console.log(JSON.stringify({ cwd, agentDir, port }));
process.on('SIGINT', () => server.close(() => process.exit()));
