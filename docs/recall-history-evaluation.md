# Recall-history comparisons

The native tests use deterministic model fixtures and authored scenes. They compare generated context and validate output attribution. The [historical live-model comparison](https://github.com/memrok-com/reverie/blob/518cb3e911e0fb5a056d7862179c2cae5b6d7c05/docs/recall-history-evaluation.md) used the earlier host integration. Sustained-play quality remains open.

## Departure and return after retrieval shifts

Earlier memory: Mara fears abandonment. Current scene: the player steps out, Mara expresses fear, the player returns, and Mara expresses reassurance. A harbor topic then displaces the abandonment memory in fresh retrieval.

| Check | Baseline without associations | Recall history |
| --- | --- | --- |
| Later reply context | Harbor retrieval plus played fear/return dialogue; no record tying the earlier abandonment recall to that reaction | Separate abandonment context tied to its first and latest successful replies |
| Reflection input | Eligible earlier memories and played scene, without activation timing | The same played scene plus bounded associations identifying when the old memory was supplied |
| Authored comparison output | “You left and returned; I felt relief.” | “Your departure stirred my old fear, but your return reassured me.” |
| Evidence | Current fear and relief remain supported by played messages | New recollection cites only the played fear and relief; abandonment retains its original episode/message provenance |

`test/native/memory.test.mjs` runs this paired comparison with the same played-source hash. The fixture chooses its phrasing based on the presence of associations so the test can check which information the engine supplied and how the reflection cites it.

## Repeated uncertain background

An earlier recollection explicitly says “I suspect, but did not witness, an abandonment,” with confidence 0.2. Repeated supply retains that wording, does not raise confidence, emits one distinct retained recollection, and preserves the first and latest associations. Oversized Unicode examples are selected within the same serialized budget. The baseline has no activation account; the new context preserves the account without adding evidence of the suspected event.

## Obsolete and future context

For re-memorization with changed source, correction, withdrawal, deletion, and forced regeneration with a changed model route, the comparison uses the same old saved references. The new context omits them from both replies and reflection once their contribution is absent or changed. Future activations, future episodes, current-episode self-references and foreign references are excluded. A history-only source change during reflection aborts publication.
