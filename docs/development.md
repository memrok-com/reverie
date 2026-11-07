# Development

Use the Node version in `.node-version` for development scripts. The scripts use built-in modules and require no npm install. The standalone executable requires neither Node nor the build tools at runtime.

The Windows native build uses the workspace-local Rust 1.99.1 GNU and portable GCC 16.2.0 toolchains under `.work/toolchains`, selected by `scripts/cargo.mjs`. Users need neither compiler.

## Set up a fresh Windows x64 checkout

Install Node 24.20.0 (the version in `.node-version`) and Git, then clone this repository and open PowerShell in its root.

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
& .work/toolchains/downloads/rustup-init.exe -y --no-modify-path --default-host x86_64-pc-windows-gnu --default-toolchain 1.99.1 --profile minimal
if ($LASTEXITCODE -ne 0) { throw 'Rust installation failed' }
Expand-Archive -LiteralPath .work/toolchains/downloads/winlibs-gcc16.2.0.zip -DestinationPath .work/toolchains/gcc16.2.0

node scripts/cargo.mjs --version
& .work/toolchains/gcc16.2.0/mingw64/bin/gcc.exe --version
```

The compiler lives in `.work/toolchains/rustup/toolchains/1.99.1-x86_64-pc-windows-gnu`; the build also accepts older local checkouts with the same compiler installed under `stable-x86_64-pc-windows-gnu`, checking the exact Rust version before use. The scripts set the compiler paths for each child process. These tools and their caches remain ignored by Git.

## Linux x64 development

Install the Node version in `.node-version` and Rust 1.99.1 with your normal Rust installation (`rustup toolchain install 1.99.1 --profile minimal`). Install a C compiler and linker, for example Ubuntu's `build-essential`, for bundled SQLite. Then run `node scripts/test-native.mjs` from the repository root. No workspace-local toolchains are needed on Linux.

`scripts/cargo.mjs` verifies the pinned compiler and builds for the compiler's host target on Linux; Windows retains the workspace-local GNU/MinGW build. Test executables resolve through `scripts/lib/native-toolchain.mjs`, with `REVERIE_TEST_ENGINE` available for a separately built executable. Without that override, Linux path resolution uses `rustc` on PATH. Use the repository scripts on Windows; direct Cargo commands follow the user's default host toolchain.

## Build and verify

Run these commands from the repository root.

```text
node scripts/cargo.mjs build --release --locked
node scripts/test-native.mjs
```

The tests run the Rust unit tests, build the release executable, and run the native and process suites against it. A test host implemented with Node built-ins supplies deterministic played source and model responses over the wire. `test/support/reflection.mjs` retains the golden-format oracle for prompt and source parity.

Linux x64 CI runs the same suite on main pushes and pull requests. Local reports go to `.work/validation`. Set `REVERIE_VALIDATION_DIR` to select another directory.

## Package a Windows x64 release

Commit the release source first. Packaging records that commit, builds with the pinned toolchain, and collects dependency notices. The Rust documentation component supplies the standard library's copyright and license files. Install it once with the same workspace-local Rust setup used above.

```powershell
$env:RUSTUP_HOME = Join-Path $PWD '.work/toolchains/rustup'
$env:CARGO_HOME = Join-Path $PWD '.work/toolchains/cargo'
& .work/toolchains/cargo/bin/rustup.exe component add rust-docs --toolchain 1.99.1-x86_64-pc-windows-gnu
node scripts/package-native.mjs
node scripts/test-package-native.mjs
```

For the older local toolchain layout, use `stable-x86_64-pc-windows-gnu` in the component command after checking its pinned version. The ZIP and `.sha256` file are written to `dist/reverie-v<version>-windows-x64.zip`. Verification checks the checksum and notices, extracts to a fresh directory, then runs storage and host-protocol tests with a runtime PATH containing only Windows system tools. It needs neither compiler nor Node on the executable's PATH.

Publish the ZIP and checksum from the tagged, clean release commit. The package includes `LICENSE`, `NOTICE`, native dependency licenses, SQLite attribution and Rust/MinGW/GCC runtime notices.
