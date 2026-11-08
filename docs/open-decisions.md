# Decisions

## Current decisions

| Area | Decision |
| --- | --- |
| Host boundary | Hosts own play, transcripts, branch selection and model access. Reverie owns derived memory. |
| Scope | One character per process, with stable character and episode IDs supplied by the host. |
| Character foundation | The host supplies the foundation appropriate to the played source and its place in the character's life. |
| Time | Explicit Gregorian dates or zoned timestamps. Episodes do not interleave. |
| Chronology planning | Relative dates resolve once from an anchor's end (after) or start (before), with explicit duplicate-anchor selection. Re-dating translates the selected interval and all branch time entries equally; previewed affected derivatives and corrections are invalidated atomically. |
| Memory | Whole-episode reflection on explicit memorization; local lexical retrieval before replies. |
| Deletion | Model-independent removal and dependent-derivative invalidation. The host owns transcript deletion. |
| Distribution | Apache-2.0 source with native executable builds and a Rust crate usable from source. |

## Still open

- Doxvelt's [scoped-audience handoff](doxvelt-scoped-audiences.md): ratification of primary/fallback projections, identity token rules and extension enablement. This is a conceptual host design, not an implemented engine feature.
- Sustained-play quality and tuning of subjective recall.
- Broader platform coverage and distribution of signed native binaries.
- Fantasy calendars and a visual timeline.
- Handling episodes exceeding the reflection model's context window.
- Semantic retrieval if lexical cue matching proves insufficient.
- A public Rust crate release.
