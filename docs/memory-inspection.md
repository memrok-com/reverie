# Memory inspection and correction

Inspection is a player-only view of published episode contributions. It reads every stored recollection and each episode's broader-impression snapshot without a retrieval cue, ranking limit, detail fading, or model call. Eligibility at a chosen episode/date is a separate chronological flag, not evidence that an item was supplied to a reply. Explain last recall remains the saved record of that reply's actual context. Source excerpts are read from the selected played branch on demand, retain player/companion authorship and literal action/dialogue text, and are never copied into memory storage.

After successful memorization, a host can inspect the published recollections and the separate broader-impression snapshot, including unchanged results. Inspection does not publish partial results from failed or cancelled operations.

## Inspect one episode

`inspectEpisode` is a separate read-only player operation. Supply required text `episodeId`, optionally the matching `characterId`. For example:

```json
{"id":1,"method":"inspectEpisode","params":{"episodeId":"meeting"}}
{"id":1,"result":{"characterId":"mara","episodeId":"meeting","revision":17,"state":"published","memories":[{"gist":"You lent me your coat.","detail":"It was warm.","feeling":"Safe.","confidence":0.9}]}}
```

The Rust entry point is `Reverie::inspect_episode(&Value) -> Result<EpisodeInspection>`; `execute("inspectEpisode", params)` exposes the same contract. States are:

| State | Meaning |
| --- | --- |
| `not-memorized` | The episode is excluded, or this valid ID is unknown in this character's scope. |
| `invalidated` | The episode remains included but has no saved contribution. |
| `stale` | The saved contribution's interval or label differs, or its exact source fingerprint cannot be confirmed. This includes changed, deleted, malformed, unavailable or timed-out source. |
| `published` | A saved contribution matches the episode and current source, including contributions with zero recollections or a pending impressions rebuild after correction. |

`memories` contains only the requested episode's saved recollections, in saved order, projected to `gist`, `detail`, `feeling`, and `confidence`. It is empty for every other state. Source, source references, corrections, impressions, dependencies and other episodes are never returned. This does not check freshness of earlier episodes or claim retrieval eligibility.

The engine takes a consistent read snapshot using SQL scoped to this character and episode. It checks the existing cross-character ownership rule (`EPISODE_CHARACTER_MISMATCH`) without loading foreign data. Missing, non-text, empty or oversized IDs return `INVALID_INPUT`; a mismatching supplied character returns `CHARACTER_MISMATCH`.

Only an included episode with a saved contribution causes a callback: at most one `source.read`, for exactly the requested character and episode, using the usual selected-branch source contract. The engine computes the source fingerprint itself; no model or other source callback occurs. Failure is closed: source callback errors yield `stale` without exposing callback error text or saved recollections. After the callback, the engine checks the character revision again, even if source failed. A changed revision returns `STALE_OPERATION`; retry the read. The stdio reader remains available while the callback waits. This read does not reserve a mutation operation: `cancel` retains its existing meaning for active mutations; closing the connection ends pending callbacks. There is no partial publication or recovery mutation, and retrying inspection is safe.

The narrow query path deliberately does not call broad `inspect`, scan earlier dependencies, or read correction snapshots. It leaves revision, stored memory, engine version, storage format and mutation behavior unchanged. Broad `inspect` retains its existing contract. Authored saved fixtures and process checks are in [inspect-episode.test.mjs](../test/native/inspect-episode.test.mjs); direct Rust API checks live alongside the engine implementation.

## Correction contract

Corrections repair factual or attribution errors in inspected recollections. They are explicit player edits, not automatic judgments about the companion's subjective feelings. The editor preserves feelings and uncertainty unless the player deliberately changes them. It never edits played source or moves an episode's fictional date.

A correction pins the episode's reviewed set of recollections, with the selected item replaced. This deliberately preserves the other reviewed recollections rather than trying to match newly generated items by array position. Multiple edits update that same set. The pin is durable, character-scoped, and bound to the exact played-source fingerprint. Re-memorization and repair rebuilding reuse those recollections and ask the model to derive impressions with the corrected recollections in view. Withdrawing an episode retains the pin for later re-memorization; deleting its source removes the pin.

Before application, a preview shows the original and replacement, the target's impressions to remove, and every later contribution to invalidate. Applying requires the preview's unchanged database revision and a fresh source check. Publication is atomic and model-independent: corrected recollections become available at their original fictional endpoint; target impressions and later contributions are removed immediately. Their inclusion choices survive for an explicit rebuild. Older replies retain their historical recall explanations.

Rebuild defaults to repair: unchanged contributions are reused, while affected contributions and their dependents are regenerated. A second unchanged rebuild calls no model. Native clients can request full regeneration with `force: true`; this can resample earlier memory, so a later correction may block publication until explicitly released. Failure leaves the previous published state intact. Model/thinking changes preserve independently validated contributions. Legacy contributions acquire independent validation without resampling when their old fingerprint matches the requested route; an unknown original route is conservatively refreshed. Model route remains recorded as provenance. See the [architecture](architecture.md).

If the source changes, the pin is marked stale and rebuilding stops with a clear error. A pin also records the preceding contribution fingerprint: changing earlier memory blocks reuse of that reviewed snapshot. The player can inspect and explicitly release the pin through another preview before re-memorizing the changed source or rebuilding changed dependencies. Releasing also invalidates the episode and all later contributions. Deletion or correction of an earlier source releases dependent pins, since their reviewed snapshots may contain knowledge derived from that source. This prevents a retained pin from resurrecting deleted derivatives.
