import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const toolchains = resolve(import.meta.dirname, '../../.work/toolchains');
const pinned = '1.99.1-x86_64-pc-windows-gnu';
// Older local checkouts installed this same compiler under the stable alias.
// cargo.mjs verifies the compiler version before allowing either layout.
export const rustToolchain = existsSync(resolve(toolchains, 'rustup/toolchains', pinned))
  ? pinned : 'stable-x86_64-pc-windows-gnu';
