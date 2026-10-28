# Progress

Reverie 0.1.0 replaces the DSH integration with a Pi 1.3.0 extension. The native Rust engine remains the production memory implementation.

Implemented: opt-in folder/character associations, terminal persona editing, memory on/off and unlinking, visible dates and memory state, draft-preserving date input, reroll/cycle shortcuts, selected-branch source reconstruction, memorization/inspection/explanation, withdrawal/rebuild/cancellation, integrated deletion, and reconciliation of externally deleted session files.

Issue #1 adds complete episode recollection browsing, separate impression snapshots, attributed played-source excerpts, complete chronological eligibility inspection, and reviewed persistent factual/attribution corrections with dependent invalidation. Changed source or prior memory requires explicit correction release before rebuilding. Player inspection remains outside character context and saved dialogue.

The acceptance suite uses the real Pi SDK and native executable. The installed Pi terminal has also been exercised with a credential-free local OpenAI-compatible test endpoint. The release archive is checked after relocation and installation through Pi's package manager.

The earlier Node memory prototype, DSH adapter, browser configuration UI, DSH test runtimes, obsolete packaging scripts and superseded validation artifacts have been removed. Test-only golden reflection fixtures and the native build toolchain remain.

See [validation](validation.md), [quickstart](quickstart.md), and [the migration acceptance plan](pi-migration-plan.md).
