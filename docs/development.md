# Development

Use Node 24.9–24.x and Pi 1.3.0. Install development dependencies with `npm ci`. Pi's SDK is a development dependency; the shipped bundle does not install another Pi.

The Windows native build uses the workspace-local Rust 1.99.1 GNU and portable GCC 16.2.0 toolchains under `.work/toolchains`, selected by `scripts/cargo.mjs`. Users need neither compiler.

## Set up a fresh Windows x64 checkout

Install Node 24.20.0 (the version in `.node-version`) and Git, then clone this repository and open PowerShell in its root. `npm ci` installs the locked JavaScript dependencies.

Download `rustup-init.exe` and its `.sha256` file using the Windows x64 links in the [official rustup installation instructions](https://rust-lang.github.io/rustup/installation/other.html). Save them as `.work/toolchains/downloads/rustup-init.exe` and `.work/toolchains/downloads/rustup-init.exe.sha256`. The installer host can be MSVC; the command below explicitly selects the GNU compiler.

Download the [WinLibs GCC 16.2.0 / MinGW-w64 14.0.0 MSVCRT release 1 ZIP](https://github.com/brechtsanders/winlibs_mingw/releases/download/16.2.0posix-14.0.0-msvcrt-r1/winlibs-x86_64-posix-seh-gcc-16.2.0-mingw-w64msvcrt-14.0.0-r1.zip) as `.work/toolchains/downloads/winlibs-gcc16.2.0.zip`. This is the x86_64 POSIX/SEH build without LLVM. Create the download directory first if needed:

```powershell
New-Item -ItemType Directory -Force .work/toolchains/downloads | Out-Null
```

After saving both downloads, verify and install them:

```powershell
$rustupExpected = ((Get-Content .work/toolchains/downloads/rustup-init.exe.sha256 -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash .work/toolchains/downloads/rustup-init.exe -Algorithm SHA256).Hash -ne $rustupExpected) {
    throw 'Rustup installer checksum mismatch'
}
if ((Get-FileHash .work/toolchains/downloads/winlibs-gcc16.2.0.zip -Algorithm SHA256).Hash -ne 'a6cb646ed5fc1c2326d29fad90bdae5b1d6251463dd81b6e37e499fe8ef80ca8') {
    throw 'WinLibs archive checksum mismatch'
}

$env:RUSTUP_HOME = Join-Path $PWD '.work/toolchains/rustup'
$env:CARGO_HOME = Join-Path $PWD '.work/toolchains/cargo'
& .work/toolchains/downloads/rustup-init.exe -y --no-modify-path --default-host x86_64-pc-windows-gnu --default-toolchain 1.99.1 --profile minimal --component rust-docs
if ($LASTEXITCODE -ne 0) { throw 'Rust installation failed' }
Expand-Archive -LiteralPath .work/toolchains/downloads/winlibs-gcc16.2.0.zip -DestinationPath .work/toolchains/gcc16.2.0

node scripts/cargo.mjs --version
& .work/toolchains/gcc16.2.0/mingw64/bin/gcc.exe --version
npm ci
```

Rust documentation is included because release packaging copies its copyright and license notices. The compiler lives in `.work/toolchains/rustup/toolchains/1.99.1-x86_64-pc-windows-gnu`; the build also accepts older local checkouts with the same compiler installed under `stable-x86_64-pc-windows-gnu`, checking the exact Rust version before use. The scripts set the compiler paths for each child process. These tools and their caches remain ignored by Git.

## Verify and package

```text
npm test
npm run build
npm run package
npm run test:package
```

The Pi tests run the real Pi SDK/session/extension machinery with a deterministic local model implementation and the real native executable. They exercise branch navigation, persona injection, cancelled date input, memorization, restart, and deletion. Pure source tests cover projection and alternate selection. Native suites verify chronology, provenance, stale-operation protection, cancellation, isolation and atomic publication.

Committed validation reports use repository-relative paths. The test runners normalize their JUnit output after every run, and the installed-package smoke records `dist/reverie-pi` without a machine-specific prefix. Keep credentials and real character data out of validation artifacts.

The release directory is `dist/reverie-pi`. Test installation with `pi install` using that directory, or load it once with `pi -e`. Test homes must stay under `.work/` and must never overwrite a user's Pi settings or memories.

If a running Pi holds the packaged engine open on Windows, set `REVERIE_PACKAGE_DIR` to a fresh directory such as `dist/reverie-pi-0.1.0` for the build, package and memory-wire smoke commands. This builds and validates a separate package without interrupting the active session. The relocated archive smoke reads the generated package report and needs no directory override.

`test/support/reflection.mjs` is a retained golden-format oracle for native prompt/source parity. It is test-only, not a second production memory engine.
