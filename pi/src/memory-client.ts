import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { ReverieError, errorCode, errorMessage, record } from './errors.js';
import type { EngineMethod, EngineResults, ReflectionRequest, SourceObservation } from './contracts.js';

interface Options {
  executable: string; characterId: string; database: string;
  settings?: Record<string, unknown>;
  readSource(id: string, signal: AbortSignal): Promise<SourceObservation>;
  infer(request: ReflectionRequest, context: { episodeId: string; modelKey: string; signal: AbortSignal }): Promise<string>;
}
interface Pending { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }

export class MemoryClient {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<number, Pending>();
  private readonly callbacks = new Map<string, AbortController>();
  private readonly exited: Promise<void>;
  private nextId = 1;
  private diagnostics = '';
  private closing?: Promise<void>;

  constructor(private readonly options: Options) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)));
    this.child = spawn(options.executable, ['--stdio', '--character', options.characterId, '--database', options.database,
      ...(options.settings ? ['--settings', JSON.stringify(options.settings)] : [])],
      { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (data: Buffer) => { this.diagnostics = (this.diagnostics + data.toString()).slice(-2000); });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line: string) => this.receive(line));
    this.child.once('error', () => this.fail(new ReverieError('MEMORY_PROCESS_UNAVAILABLE', 'The bundled memory engine could not start. Reinstall or enable the Reverie plugin again.')));
    this.child.stdin.on('error', () => this.fail(new ReverieError('MEMORY_PROCESS_EXITED', 'The memory process connection closed.')));
    this.exited = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.fail(new ReverieError('MEMORY_PROCESS_EXITED', 'The memory engine stopped (' + (code ?? signal) + '). ' + this.diagnostics));
      resolve();
    }));
  }

  private receive(line: string) {
    let message: unknown;
    try { message = JSON.parse(line); } catch { /* Checked below. */ }
    if (!record(message)) {
      this.fail(new ReverieError('INVALID_PROCESS_RESPONSE', 'The memory engine returned an invalid response.'));
      this.child.kill(); return;
    }
    if (typeof message.cancelCall === 'string') { this.callbacks.get(message.cancelCall)?.abort(); return; }
    if (typeof message.callId === 'string') { void this.answerCallback(message.callId, message.method, message.params); return; }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); pending.cleanup();
    if (record(message.error)) pending.reject(new ReverieError(errorCode(message.error), errorMessage(message.error)));
    else pending.resolve(message.result);
  }

  private send(value: unknown) {
    if (this.child.stdin.destroyed || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new ReverieError('MEMORY_PROCESS_EXITED', 'The memory engine is not running.');
    }
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  private async answerCallback(id: string, method: unknown, params: unknown) {
    const controller = new AbortController(); this.callbacks.set(id, controller);
    try {
      if (!record(params) || params.characterId !== this.options.characterId) {
        throw new ReverieError('CHARACTER_MISMATCH', 'The memory engine requested another character.');
      }
      if (typeof params.episodeId !== 'string') throw new ReverieError('INVALID_CALLBACK', 'The memory callback has no conversation identity.');
      let result: unknown;
      if (method === 'source.read') result = await this.options.readSource(params.episodeId, controller.signal);
      else if (method === 'model.reflect' && record(params.request) && typeof params.modelKey === 'string') {
        result = await this.options.infer(params.request as unknown as ReflectionRequest,
          { episodeId: params.episodeId, modelKey: params.modelKey, signal: controller.signal });
      } else throw new ReverieError('UNKNOWN_CALLBACK', 'Unknown memory callback.');
      if (!controller.signal.aborted) this.send({ callId: id, result });
    } catch (error) {
      if (!controller.signal.aborted) {
        try { this.send({ callId: id, error: { code: errorCode(error), message: errorMessage(error) } }); }
        catch { /* The process may exit while an asynchronous callback settles. */ }
      }
    } finally { this.callbacks.delete(id); }
  }

  request<M extends EngineMethod>(method: M, params: Record<string, unknown> = {}, { signal }: { signal?: AbortSignal } = {}): Promise<EngineResults[M]> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new ReverieError('CANCELLED', 'Memory request cancelled.')); return; }
      const id = this.nextId++;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const abort = () => {
        if (['memorize', 'unmemorize', 'rebuild'].includes(method)) {
          try { this.send({ id: this.nextId++, method: 'cancel', params: {} }); } catch { /* Already stopped. */ }
        }
        this.pending.delete(id); cleanup(); reject(new ReverieError('CANCELLED', 'Memory request cancelled.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve: value => resolve(value as EngineResults[M]), reject, cleanup });
      try { this.send({ id, method, params }); } catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    for (const callback of this.callbacks.values()) callback.abort();
    this.callbacks.clear();
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.child.stdin.end();
      const timer = setTimeout(() => this.child.kill(), 5000); timer.unref();
      await this.exited; clearTimeout(timer); this.lines.close();
    })();
  }
}
