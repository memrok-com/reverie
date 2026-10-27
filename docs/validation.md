# Validation and limits

The current target is Pi 1.3.0 on Windows x64 with Node 24.9–24.x. Other platforms and Pi versions are not advertised as verified.

Native tests cover fictional chronology and fading, episode ownership, selective reflection and provenance, source mutation, cancellation, restart, invalid reflection, atomic publication, and model-independent deletion invalidation. Pi integration tests exercise its actual SDK, append-only sessions and extension runtime with a deterministic model and the native engine.

The terminal smoke and package smoke are recorded separately. A passing SDK test is not a substitute for checking shortcut dispatch and visible controls in an actual Pi terminal.

`scripts/pi-memory-wire-smoke.mjs` also exercises the packaged extension through a real Pi CLI and a credential-free OpenAI-compatible HTTP fixture. `validation/pi-memory-wire.json` records that empty recall adds no notice, actual recollections have the system role, and the player's unchanged message stays last. This check uses no real character data or external model.

The current reports are `validation/native-tests.xml` (27 native/process acceptance tests), `validation/pi-tests.xml` (23 Pi acceptance tests), `validation/pi-package-smoke.json` (relocated archive and package installation), `validation/pi-terminal.json` (installed terminal interaction), and `validation/pi-installed.json` (registration in the existing user Pi installation). Three Rust unit tests also pass. The Pi suite includes real compaction entries, append-only message edits, persisted recall provenance, retries after failed/interrupted first generations, and saved per-folder model choices across reload/new sessions/restart. Missing-model tests verify that input and continuation paths do not reach a fallback provider. Provider-facing context tests verify empty recall produces no placeholder, real recall appears only in system context, the latest user message stays last, and memory does not accumulate or enter played source.

The quality of remembered prose remains model-dependent. Retrieval uses lexical matching with reflected cue words, recency and emotional salience; there is no embedding model or inference call during retrieval. Reflection requires the full selected episode to fit the configured model context. Reflection can fail safely on invalid or overlong output.

Reply alternatives are branches. Only the selected history is memorized. Rejected branches remain in Pi's file until the whole chat is deleted. Branch changes after memorization require memorizing again. Later derivatives of a deleted episode are withheld until rebuilt; deletion never waits for a successful model call.

The source is public under Apache-2.0. The npm package has not been published to the registry, and native executables are unsigned. Release bundles include Reverie's LICENSE and NOTICE together with third-party license notices.
