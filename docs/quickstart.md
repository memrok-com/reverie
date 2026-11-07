# Connect a host

Install the development tools for your platform using the [setup guide](development.md). From the repository root, build the native executable.

```text
node scripts/cargo.mjs build --release --locked
```

The executable is under `engine/target/<host-target>/release/`. On Windows x64 the target is `x86_64-pc-windows-gnu` and the executable is `reverie-engine.exe`. The executable needs no Node or Rust installation to run.

Launch it with a stable character ID and a writable SQLite path supplied by your host.

```text
reverie-engine --stdio --character mara --database ./mara.sqlite
```

Send one JSON object per line to standard input. For example, send a request to identify the process and check its protocol version.

```json
{"id":1,"method":"ping","params":{}}
```

Read the response from standard output. This build reports protocol version 1.

```json
{"id":1,"result":{"version":"0.1.0","characterId":"mara","protocol":1,"runtime":"rust"}}
```

Use `when` with an episode ID and fictional date to place the episode, then request `memorize` when the player explicitly asks to form memory. During memorization, the engine requests the played source and calls back for model reflection. A host must handle those callbacks while awaiting the response. Use `inspect` to read published memory or `retrieve` to select eligible context for a later episode.

See the [host protocol](architecture.md) for envelopes and callbacks. The [native process tests](../test/process.test.mjs) exercise the full round trip with a deterministic model. A Rust host linking the crate directly can supply the same callbacks through [`Bridge`](../engine/src/engine.rs).
