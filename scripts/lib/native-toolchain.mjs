import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const toolchains = resolve(import.meta.dirname, '../../.work/toolchains');
const pinned = '1.99.1-x86_64-pc-windows-gnu';
// Older local checkouts installed this same compiler under the stable alias.
// cargo.mjs verifies the compiler version before allowing either layout.
export const rustToolchain = existsSync(resolve(toolchains, 'rustup/toolchains', pinned))
  ? pinned : 'stable-x86_64-pc-windows-gnu';

export function nativeTarget() {
  if (process.platform === 'win32') return 'x86_64-pc-windows-gnu';
  const version = spawnSync('rustc', ['-vV'], { env: { ...process.env, RUSTUP_TOOLCHAIN: '1.99.1' }, encoding: 'utf8' });
  const host = version.stdout?.match(/^host: (\S+)$/m)?.[1];
  if (version.error || version.status !== 0 || !host) throw version.error ?? new Error('Install Rust 1.99.1 for the host target. See docs/development.md.');
  return host;
}

/** Tests can use a separately built engine without requiring its compiler. */
export function nativeEnginePath(profile = 'release') {
  if (process.env.REVERIE_TEST_ENGINE) return resolve(process.env.REVERIE_TEST_ENGINE);
  return resolve(import.meta.dirname, '../../engine/target', nativeTarget(), profile,
    process.platform === 'win32' ? 'reverie-engine.exe' : 'reverie-engine');
}
