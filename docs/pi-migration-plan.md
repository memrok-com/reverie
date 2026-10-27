# Pi migration

Reverie 0.3.0 replaces the DSH host with a Pi 1.3.0 extension while retaining the Rust memory engine. The acceptance items below are implemented and verified on Windows x64.

## Acceptance

- Install one Pi package; the bundled native engine starts automatically.
- Create/link a character in a folder, edit its persona in the TUI, enable/disable memory, and unlink without losing stored memory.
- Display the character, story date, memory state, and selected reply alternative.
- Ask for missing fictional time before generation without losing the opening message.
- Reroll and cycle saved alternatives using shortcuts and commands; only the selected branch is source.
- Memorize, inspect, explain, withdraw, rebuild, cancel, and delete through visible controls.
- Detect deleted session files before recall; invalidate dependent memory without requiring a model call.
- Verify real Pi extension loading, native behavior, packaging, and terminal interaction.
- Replace obsolete documentation and remove the Node prototype and DSH-only code after replacement checks pass. Preserve user data and useful test fixtures.

## Design

Pi owns sessions and model configuration. A TypeScript extension owns folder associations, persona authoring, UI, source projection, and local process supervision. Rust owns chronology, memory formation, retrieval, and atomic deletion invalidation. Extension data lives outside package installation directories. Existing DSH databases are preserved; their source references are not silently reassigned to Pi.

Persistent character and source metadata uses a separate SQLite catalog to support concurrent Pi processes. Each session retains its original character owner. Reply alternatives use Pi's append-only tree, with branch summaries disabled for alternative navigation. Full played source is reconstructed from the selected branch, excluding injected recollections and compaction summaries.
