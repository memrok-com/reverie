import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function wireError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Standalone test host for the native protocol. All sources and model replies
// come from fixtures supplied by the test.
export class MemoryClient {
  #options;
  #lines;
  #pending = new Map();
  #callbacks = new Map();
  #exited;
  #nextId = 1;
  #diagnostics = '';
  #closing;

  constructor(options) {
    this.#options = options;
    const { executable, characterId, database, settings } = options;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)));
    this.child = spawn(executable, ['--stdio', '--character', characterId, '--database', database,
      ...(settings ? ['--settings', JSON.stringify(settings)] : [])],
    { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', data => { this.#diagnostics = (this.#diagnostics + data.toString()).slice(-2000); });
    this.#lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.#lines.on('line', line => this.#receive(line));
    this.child.once('error', error => this.#fail(wireError('MEMORY_PROCESS_UNAVAILABLE', error.message)));
    this.child.stdin.on('error', error => this.#fail(wireError('MEMORY_PROCESS_EXITED', error.message)));
    this.#exited = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.#fail(wireError('MEMORY_PROCESS_EXITED', `The memory engine stopped (${code ?? signal}). ${this.#diagnostics}`));
      resolve();
    }));
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { /* Checked below. */ }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#fail(wireError('INVALID_PROCESS_RESPONSE', 'The memory engine returned an invalid response.'));
      this.child.kill();
      return;
    }
    if (typeof message.cancelCall === 'string') {
      this.#callbacks.get(message.cancelCall)?.abort();
      return;
    }
    if (typeof message.callId === 'string') {
      void this.#answer(message.callId, message.method, message.params);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(wireError(message.error.code, message.error.message));
    else pending.resolve(message.result);
  }

  #send(value) {
    if (this.child.stdin.destroyed || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw wireError('MEMORY_PROCESS_EXITED', 'The memory engine is not running.');
    }
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  async #answer(id, method, params) {
    const controller = new AbortController();
    const { signal } = controller;
    this.#callbacks.set(id, controller);
    try {
      if (params?.characterId !== this.#options.characterId) {
        throw wireError('CHARACTER_MISMATCH', 'The memory engine requested another character.');
      }
      let result;
      if (method === 'source.read') {
        result = await this.#options.readSource(params.episodeId, signal);
      } else if (method === 'model.reflect') {
        const onProgress = () => {
          if (!signal.aborted && this.#callbacks.get(id) === controller) this.#send({ callProgress: id });
        };
        result = await this.#options.infer(params.request, { episodeId: params.episodeId, modelKey: params.modelKey, signal, onProgress });
      } else {
        throw wireError('UNKNOWN_CALLBACK', `Unexpected memory callback ${method}.`);
      }
      if (!signal.aborted) this.#send({ callId: id, result });
    } catch (error) {
      if (!signal.aborted) {
        try { this.#send({ callId: id, error: { code: error?.code ?? 'MEMORY_FAILURE', message: error?.message ?? 'Memory operation failed.' } }); }
        catch { /* The process may exit while a callback settles. */ }
      }
    } finally {
      this.#callbacks.delete(id);
    }
  }

  request(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try { this.#send({ id, method, params }); }
      catch (error) { this.#pending.delete(id); reject(error); }
    });
  }

  #fail(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const callback of this.#callbacks.values()) callback.abort();
    this.#callbacks.clear();
  }

  close() {
    return this.#closing ??= (async () => {
      this.child.stdin.end();
      const timer = setTimeout(() => this.child.kill(), 5000);
      timer.unref();
      await this.#exited;
      clearTimeout(timer);
      this.#lines.close();
    })();
  }
}
