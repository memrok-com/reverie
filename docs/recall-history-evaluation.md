# Recall-history comparisons

The native and real-Pi SDK tests use deterministic local models and authored scenes. They compare actual generated context and validate output attribution. A small live-model comparison is recorded below; it does not establish a general emotional or literary quality gain. Sustained-play quality remains open.

The opt-in `node scripts/evaluate-recall-history.mjs` harness runs a reply and native-validated reflection for each condition in the two authored scenes below (eight model calls total, with reflection retries disabled). It uses Pi's configured provider runtime and keeps authentication refreshes in memory, synthetic source and output under `.work/recall-history-evaluation`, and model-cache writes in that same isolated folder. Explicit `--provider`, `--model` and `--thinking` options allow a user-selected route without changing saved defaults. No private stories are read.

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

## Live comparison on 2026-10-29

Ran `node scripts/evaluate-recall-history.mjs --provider openai --model gpt-6.1-sol --thinking medium` using the explicitly selected model. Full prompts, outputs, published contributions and SDK usage are in [the raw comparison record](../validation/recall-history-live.json).

Each scene has one baseline reply/reflection pair and one history pair. Condition order is reversed for the second scene. Earlier memories are authored fixtures; current replies and reflections are live model outputs. The roleplay continuation is evaluated separately from reflection so each reflection sees exactly the same four played messages. Baseline and history contributions have identical played-source hashes in both scenes.

| Criterion | Observation |
| --- | --- |
| Execution | Eight live calls completed; all four reflections passed native format/reference validation on their first attempt. |
| Emotional continuity | Both conditions produced guarded, plausible replies. In departure/return, both replies agreed to sit beside the player; in uncertain background, both accepted company. No clear continuity improvement was visible in this sample. |
| New episode evidence | Each reflection retained two recollections supported exclusively by current played-message IDs. Neither condition duplicated the old gate event or asserted a new betrayal. |
| Uncertainty | The baseline explicitly called old suspicion unproven in its impression. The history condition focused on the supported current mistaken assumption and did not promote old suspicion to witnessed fact. |
| Cross-episode interpretation | Baseline impressions explicitly cited old and current episodes. History impressions cited only the current episode. Historical context was present with its original provenance in the history requests, but it did not produce a stronger explicit cross-episode connection here. |

This is an unblinded comparison with one sample per condition per scene. It verifies that the live pipeline accepts the intended context and preserves evidence boundaries in these examples; it does not demonstrate a consistent prose-quality gain. Keep automatic reinforcement deferred. Further tuning should use multiple samples and sustained-play scenes, including unrelated controls, before claiming improved emotional continuity.
