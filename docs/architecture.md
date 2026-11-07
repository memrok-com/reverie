# Architecture

The Rust engine owns subjective memory, fictional chronology, reflection validation and retrieval. The host owns canonical transcripts and branch selection, character foundations, model configuration and credentials, and the player interface. The host supplies the source as each character experienced it and decides how to inject retrieved memory into the character's context.

## Native host protocol

Launch `reverie-engine --stdio --character ID --database PATH` for the character whose memory the host needs. The engine accepts optional JSON settings through `--settings`. A Rust host can instead embed the engine and implement the [`Bridge`](../engine/src/engine.rs) trait for source and reflection.

The executable exchanges one JSON object per line over stdin and stdout. Request IDs correlate commands with their responses. Callback IDs have a separate scope and the host must keep reading while a command is in flight.

| Direction | Envelope |
| --- | --- |
| Host to engine | `{"id":1,"method":"ping","params":{}}` |
| Engine to host | `{"id":1,"result":{…}}` or `{"id":1,"error":{"code":"…","message":"…"}}` |
| Engine to host | `{"callId":"…","method":"source.read","params":{…}}` or `model.reflect` with the same envelope |
| Host to engine | `{"callId":"…","result":…}` or `{"callId":"…","error":{"code":"…","message":"…"}}` |
| Host to engine | `{"callProgress":"…"}` while a reflection is making progress |
| Engine to host | `{"cancelCall":"…"}` when a callback must stop |

`source.read` identifies a character and episode. Supply the foundation and played messages, including stable source message IDs, from the selected source. Keep host controls, injected recall and rejected alternatives outside those messages. `model.reflect` identifies the character, episode and model key. It supplies a request containing the system instructions, structured input and token budget. Return the model's reflection as JSON text or a parsed JSON value. See the [process tests](../test/process.test.mjs) and the [protocol implementation](../engine/src/protocol.rs).

Reflection callbacks have a configurable inactivity deadline of ten minutes by default. Progress for that callback renews the deadline. Source reads have a separate three-minute deadline. To tune the reflection timeout, pass `reflectionInactivityMs` in engine settings. Changing this setting does not regenerate published memory.

## Source, chronology and storage

SQLite stores character-scoped episode metadata, derived recollections, impressions and correction snapshots. The engine uses source IDs and fingerprints to validate provenance and detect changes before publication. The host remains responsible for preserving and exporting the canonical transcript.

An episode's interval includes its fictional time jumps. Episode intervals cannot interleave. A host managing multiple branches can supply the furthest branch end to `previewRedate` as `branchEnd`. Re-dating shifts both endpoints of the selected interval and records the cumulative time offset. Source identities stay stable. `applyRedate` verifies the preview revision and invalidates affected memory atomically. The host owns changes to source timestamps.

## Formation, retrieval and inspection

`memorize` forms an episode's contribution explicitly. `unmemorize` withdraws it and keeps the transcript with the host. Ordinary `rebuild` repairs changed or invalidated contributions and reuses unchanged ones. Use `force: true` to deliberately regenerate all included episodes. The engine stages results and validates source, dependencies and database revisions before publishing. Failure or cancellation preserves previously published memory.

Contributions retain their original model route as `modelKey` provenance. A separate `reuseHash` validates reflection version, source, interval, label, preceding memory and relevant settings independently of that route. Legacy contributions can acquire this metadata without resampling when their old fingerprint matches the requested route. An unknown original route triggers a conservative refresh. Metadata adoption leaves published identities and correction prefixes intact.

`retrieve` selects chronologically eligible memory without a model call. The current episode's previous contribution is excluded. `inspect` returns published contributions and separate eligibility flags without retrieval ranking. Correction previews and application bind reviewed recollections to source and prior-memory fingerprints. See [memory inspection and correction](memory-inspection.md) and [recall history](recall-history.md).

`forget` removes the episode from native memory and invalidates derivatives from the earlier of its current and published start when applicable. `clearMemory` is character-scoped and requires the current revision. The host is responsible for deleting canonical source and cleaning up any saved reply contexts it owns. Rebuild reads the surviving included sources.
