import { spawnSync } from 'node:child_process';
import { resolve, delimiter } from 'node:path';
import { existsSync } from 'node:fs';
import { toolchains, rustToolchain } from './lib/native-toolchain.mjs';

// Development tooling only. The delivered Rust executable does not run Node.
const root = resolve(import.meta.dirname, '..');
const local = toolchains;
const gcc = resolve(local, 'gcc16.2.0/mingw64/bin');
const cargo = resolve(local, 'cargo/bin/cargo.exe');
if (!existsSync(cargo) || !existsSync(resolve(gcc, 'gcc.exe'))) {
  throw new Error('Prepare the workspace-local Rust 1.99.1 GNU toolchain and portable GCC 16.2.0 before building. See docs/development.md.');
}
const env = { ...process.env, RUSTUP_HOME: resolve(local, 'rustup'), CARGO_HOME: resolve(local, 'cargo'),
  RUSTUP_TOOLCHAIN: rustToolchain,
  CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: resolve(gcc, 'gcc.exe'),
  CC_x86_64_pc_windows_gnu: resolve(gcc, 'gcc.exe'), AR_x86_64_pc_windows_gnu: resolve(gcc, 'ar.exe'),
  PATH: [gcc, resolve(local, 'cargo/bin'), process.env.PATH].join(delimiter) };
const version = spawnSync(resolve(local, 'cargo/bin/rustc.exe'), ['--version'], { env, encoding: 'utf8', windowsHide: true });
if (version.status !== 0 || !version.stdout.startsWith('rustc 1.99.1 ')) throw new Error('The native build is pinned to Rust 1.99.1.');
const result = spawnSync(cargo, process.argv.slice(2), { env, cwd: resolve(root, 'engine'), stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
