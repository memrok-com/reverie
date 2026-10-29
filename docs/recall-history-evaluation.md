# Recall-history comparisons

The native and real-Pi SDK tests use deterministic local models and authored scenes. They compare actual generated context and validate output attribution. They do not measure live-model emotional or literary quality; sustained-play quality remains open.

The opt-in `node scripts/evaluate-recall-history.mjs` harness runs a reply and native-validated reflection for each condition in the two authored scenes below (eight model calls total, with reflection retries disabled). It uses the configured Pi model and keeps authentication refreshes in memory, synthetic source and output under `.work/recall-history-evaluation`, and model-cache writes in that same isolated folder. Explicit `--provider`, `--model` and `--thinking` options allow a user-selected route without changing saved defaults. No private stories are read. On 2026-10-29, authentication was restored but the provider rejected the saved GPT-5.5 model for ChatGPT sign-in. The live comparison awaits an explicit replacement model; no live quality result is claimed yet.

## Departure and return after retrieval shifts

Earlier memory: Mara fears abandonment. Current scene: the player steps out, Mara expresses fear, the player returns, and Mara expresses reassurance. A harbor topic then displaces the abandonment memory in fresh retrieval.

| Check | Baseline without associations | Recall history |
| --- | --- | --- |
| Later reply context | Harbor retrieval plus played fear/return dialogue; no record tying the earlier abandonment recall to that reaction | Separate abandonment context tied to its first and latest successful replies |
| Reflection input | Eligible earlier memories and played scene, without activation timing | The same played scene plus bounded associations identifying when the old memory was supplied |
| Authored comparison output | “You left and returned; I felt relief.” | “Your departure stirred my old fear, but your return reassured me.” |
| Evidence | Current fear and relief remain supported by played messages | New recollection cites only the played fear and relief; abandonment retains its original episode/message provenance |

`test/native/memory.test.mjs` runs this paired comparison with exactly the same played-source hash. The fixture deliberately chooses its phrasing based on the presence of associations: that demonstrates the information available and citation contract, not an independent quality score. The real Pi integration test verifies that first/latest links survive rerolls, selected alternatives and restart and enter reflection separately from dialogue.

## Repeated uncertain background

An earlier recollection explicitly says “I suspect, but did not witness, an abandonment,” with confidence 0.2. Repeated supply retains that wording, does not raise confidence, emits one distinct retained recollection, and preserves the first and latest associations. Oversized Unicode examples are selected within the same serialized budget. The baseline has no activation account; the new context preserves the account without adding evidence of the suspected event.

## Obsolete and future context

For re-memorization with changed source, correction, withdrawal, deletion, and forced regeneration with a changed model route, the comparison uses the same old saved references. The new context omits them from both replies and reflection once their contribution is absent or changed. Future activations, future episodes, current-episode self-references and foreign references are excluded. A history-only source change during reflection aborts publication.

## Live-model review rubric

For follow-up playtesting, replay the same departure/return scene under the same model and thinking level, once without and once with associations. Judge whether the later response retains the relevant emotional connection, whether reflection expresses the supported new experience rather than duplicating abandonment, whether suspicion remains qualified, and whether unrelated scenes stay unaffected. Compare multiple samples before drawing a model-quality conclusion. The PR does not claim that this live-model evaluation has been run.
