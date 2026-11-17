# Export and restore character memory

Hosts export their own transcripts, branch selections and character foundations.
Reverie exports dated episodes, inclusion choices, published recollections,
impressions, reviewed corrections and provenance. Transfer makes no model calls
and does not regenerate memories. SQLite row IDs and search indexes are rebuilt;
recall references based on contribution hashes remain stable.

These operations are available through `Reverie::execute` in Rust and protocol 1
over JSON lines. Older protocol-1 builds return `UNKNOWN_METHOD`; use a build
implementing memory archive version 1.

## Export

Call `exportMemory` with `{}`. The result is `{archive, revision}`. The archive has
`format: "reverie-memory"`, `version: 1`, `characterId`, `episodes`,
`contributions`, `corrections`, `sources` and a SHA-256 `checksum` over the other
fields in their canonical serialization. Treat this as an opaque JSON value;
do not rewrite identities or recompute the checksum in a host.

Contributions are stored in chronological order. In the archive only, a
contribution's `dependencies` can be `{"prefix": N}`, referring to the first N
contributions in that array. The engine expands this into the original episode
IDs before checking `stateHash` or publishing. Before expansion, the complete
dependency collection is checked against the decoded limits below. Sparse
histories use an explicit array of dependency IDs, preserving their exact order. The normal complete
preceding history therefore takes constant space per contribution on the wire;
published contribution identities and hashes do not change.

The engine calls `source.read` twice per episode and checks the memory revision
before returning. Keep canonical source and branch selection stable throughout.
A source callback can return `{deleted:true}`. Current source fingerprints are
separate from the fingerprints on which published memory was formed, preserving
stale memory, withdrawn episodes and pending rebuilds accurately.

The host must capture its own matching data consistently and retain it with the
archive. A memory archive contains fingerprints, not transcripts or credentials.

## Review and import

1. Restore matching canonical source in an isolated destination, preserving
   character, episode and source-message identities and the character foundation.
2. Start Reverie for that character against an empty destination database.
3. Call `previewImport` with `{archive}`. It validates format, checksum,
   chronology, records and destination. Results include `status`, `revision`,
   `archiveHash`, counts, `pendingEpisodes` and `modelCalls: 0`. Preview makes no
   callbacks and changes no data. `pendingEpisodes` includes later included
   episodes affected by a stale or missing earlier contribution, as inspection
   does. Hosts can fully validate sources by importing
   into an isolated temporary database before offering their final import action.
4. Call `importMemory` with `{archive, revision, archiveHash}` from that preview.
   Handle `source.read` callbacks. Source must match the archive's current-source
   fingerprints, including deleted source.
5. Publish the complete host restore only after every character has imported.

Import verifies source twice and checks destination revision and ownership again
inside its publication transaction. Results include `status: "imported"`, the new
`revision`, `archiveHash`, `episodes` and `contributions`. Existing character
episodes and another character's episode identities are never replaced.

An exact retry against the same logical memory returns `status: "current"`, even
after restart. It does not replace or regenerate data. Saved rebuild work stays
pending; request `rebuild` separately when the player wants it. The host continues
to supply engine settings; importing does not change retrieval configuration.

## Cancellation and recovery

Export, preview and import synchronously reserve the ordinary operation slot.
Archive decoding and validation run in the worker, keeping the protocol reader
available for `status`, `cancel` and callback replies. A busy transfer request is
rejected before archive decoding. Use `status`
and `cancel`, and continue servicing the JSON-lines reader. Cancellation aborts
outstanding callbacks. Cancellation before publication, callback failure, source
drift, revision conflict and storage failure preserve previous memory.

SQLite commits all imported records and rebuilt indexes together. Interruption
before commit rolls back; after commit an exact retry returns `current`. If the
response is lost, check or retry the exact operation before assuming failure.

| Code | Host response |
| --- | --- |
| `UNSUPPORTED_ARCHIVE` | Use an engine supporting this archive version. |
| `ARCHIVE_TOO_LARGE` | The story exceeds a transfer capacity limit; its memory is not corrupt. |
| `INVALID_ARCHIVE` | Keep the original export; reject damaged or invalid records. |
| `CHARACTER_MISMATCH` | Start the archive's character. |
| `IMPORT_CONFLICT` | Choose an empty destination. |
| `EPISODE_CHARACTER_MISMATCH` | Preserve ownership or choose a separate database. |
| `STALE_SOURCE` | Restore matching transcript, foundation and branch selection. |
| `STALE_OPERATION` | Preview against the current destination revision again. |
| `OPERATION_IN_PROGRESS` | Wait for or cancel the active operation. |
| `CANCELLED` | Check host restore state and retry when requested. |

Callback error codes propagate unchanged. Transfer has four independent capacity
limits: 64 MiB of encoded JSON, 10,000 episodes, 4,000,000 decoded dependency IDs,
and 128 MiB of UTF-8 text across those decoded IDs. Compact prefixes and explicit
lists share the same cumulative dependency limits, checked before any prefix
expansion or checksum validation. Export enforces the same decoded limits so an
export it returns fits the decoder's dependency budget. Which limit is reached
first depends on recollection lengths, identity lengths and dependency history.
These are ceilings, not a promise that every story of 10,000 episodes fits.
Oversized transfers return `ARCHIVE_TOO_LARGE`, without changing saved memory.
Checksums detect corruption and are not author signatures.
