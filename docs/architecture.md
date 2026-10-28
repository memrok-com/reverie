# Architecture

Pi owns source conversations, active branches, model/provider settings, credentials and the terminal. The extension owns character/folder associations, persona editing, controls, source projection and process supervision. The Rust engine owns memory, chronology, reflection validation and retrieval.

## Local package

`@memrok-com/reverie-pi` declares one Pi extension entry. Its bundled JavaScript uses Node built-ins. Native binaries live under `bin/<platform>-<arch>/`. The verified release currently includes Windows x64 only. Unsupported platforms fail with an explicit compatibility message rather than downloading code.

The extension starts a native process lazily for each character in use and speaks a JSON-lines stdio protocol. The process asks the adapter for source or reflection. Reflection uses Pi's configured model registry, preserving request-time authentication. The child environment excludes credential-shaped variables. Local retrieval does not invoke a model.

Reflection callbacks use a configurable inactivity deadline (ten minutes by default), renewed by text/thinking deltas through a callback-scoped `callProgress` message. Progress for an expired or unrelated callback cannot renew another operation; source reads retain their separate absolute three-minute deadline. Timeout aborts the host callback and fails publication atomically. Transport timeout settings are excluded from reflection input fingerprints so tuning them cannot regenerate memory. `REVERIE_REFLECTION_INACTIVITY_SECONDS` configures new extension processes; native clients can set `reflectionInactivityMs` in engine settings.

## Durable state

A WAL-mode SQLite catalog stores characters and personas, canonical folder associations, folder-specific model choices, source session paths and selected leaves, reply recall explanations, shortcut preferences and deletion tombstones. The native SQLite database stores scoped episodes, selective recollections and derived impressions. Both live under Pi's agent data directory, outside the installed package.

Pi normally waits for a user/assistant message before writing a session file. On quit or session replacement, Reverie writes a dated, unplayed session's header and metadata to its Pi session path and registers it as a source. It never does this during reload, when the same session manager will continue and still owns its first flush. No dialogue is fabricated. Episode chat controls can recover legacy date-only records into a fresh Pi runtime with their original identity or explicitly delete them even when no source path was registered.

Folder links are opt-in. Unlinked Pi use remains ordinary coding-agent use. Linked character chats suppress coding tools and use the character foundation. A session's original character identity is recorded in both Pi metadata and the catalog; relinking cannot transfer an existing chat's memories.

Explicit model selections and thinking-level changes update a folder's saved provider, model and thinking level. The catalog migrates older model preferences with an initially unset thinking level, then captures the current effective level on first restoration. Restoration sets the model before applying thinking through Pi's capability clamping, even when the model already matches. Restoration never changes Pi's global defaults or saves a fallback as the new preference. Input and reroll guards restore the saved choice before generation; a context guard also aborts continuation paths on a model mismatch. Memory reflection passes the captured thinking level to the model as well. Missing models or credentials pause generation until the user selects an available replacement. Credentials remain in Pi's own configuration.

At request time, the system-context hook supplies the persona and, only when recall is nonempty, a clearly labeled private memory section. Recollections are fallible background data rather than dialogue or instructions. Empty recall contributes no placeholder. No user or assistant turn is fabricated, and the player's latest message remains the final dialogue turn. This projection is not saved as played source; legacy custom recall messages are filtered out before model conversion. Pi's normal custom-message path is avoided because it converts custom entries to user messages.

## Source and alternatives

Player inspection uses a separate native `inspect` operation over complete published contributions, with no cue, ranking limit or model call. The adapter displays stored recollections, impression snapshots and chronological eligibility separately from saved reply-context explanations. Played excerpts are transient source callbacks; inspection never enters dialogue, model context or compaction. Source unavailability preserves the last published contribution while exposing an explicit freshness warning.

The native schema migrates version 1 to version 2 by adding character-scoped correction snapshots. A reviewed correction pins an episode's recollections against its source and preceding-memory fingerprints. Preview/application uses a per-process token, database revision and fresh source check; application atomically replaces the recollections, clears current impressions and invalidates later derivatives. Generated impression rebuilding receives the reviewed recollections. Earlier-source deletion or correction releases dependent snapshots; other source/prefix changes block reuse until explicit release. See the [inspection and correction contract](memory-inspection.md).

Source follows Pi entry identities and parent links through the chosen branch. It includes played user/assistant text and the foundation recorded for that episode, excluding tool results, custom UI entries, injected recall and compaction summaries. Original played entries remain available through compaction. Source hashes detect meaningful changes before native publication.

Reroll navigates to the preceding user message and resubmits it. Alternative cycling navigates to an existing reply and appends a state-only selection anchor, making selection survive restart. No rejected-branch summary is carried into the story. Re-memorization replaces the episode's previous contribution and refreshes dependent later reflections.

## Deletion

Known source files are checked on startup, periodically and before recall. A missing file creates a durable tombstone only if its parent directory remains accessible. Missing directories and disconnected drives remain unavailable sources until they return, or the player explicitly deletes the episode. Unreadable sources retain their saved memory and produce one warning per unavailable period, while other sources continue reconciling. Readability recovery permits a new warning on a later failure; failed notifications are retried. Memory operations that need an unavailable source report its read error without publishing partial results. Cleanup is idempotent. Native `forget` removes unmemorized source without invalidating unrelated memory. For published source it invalidates derivatives from the earlier of the current and published start, consistently using published episode identities for memories, contributions and pins. Surviving inclusion choices remain intact. A revision increment prevents in-flight reflection from republishing deleted source. A model-backed rebuild restores affected memory from surviving source.

Recall-explanation records for an affected character are cleared during cleanup. Original transcripts are deleted only by an explicit delete action or the host/user; the memory engine does not delete source files. Built-in Pi deletion has no extension event in 1.3.0, so reconciliation is required in addition to Reverie's integrated delete command.

## Boundaries

The previous Node engine and DSH adapter are retired. Their user data is neither erased nor automatically imported. Pi does not provide a complete built-in persona or reply-variant product: those controls belong to this extension. Episodic reflection still needs the full selected source to fit the chosen model's context window. Dates are explicit Gregorian dates/zoned timestamps; episodes cannot interleave.
