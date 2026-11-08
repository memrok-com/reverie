# Doxvelt: scoped audiences and actor projections

Conceptual handoff for concise inline authoring of different audiences within one atomic turn. These are intended host semantics, not a report of implemented behavior. Transcript visual design is out of scope. The primary/fallback extension below is proposed and not yet ratified.

## Authoring

`@Corin` selects the acting identity. There is no separate addressee concept. A leading `#Mara,Nell` sets the base audience for this turn; lists use commas.

Without a turn override, use the explicitly selected, visible composer default. Retain that default across turns in the current authoring context. Turn overrides never modify it. Review or reset the default when changing simulation or branch context. Audience defaults do not change physical presence or grant observation or access.

`#Mara(text)` replaces the audience for that span only. Closing the span restores the base audience. A span may name recipients outside the base audience without granting them the surrounding text. Require a resolved audience for unscoped content; never silently fall back to everyone. The actor retains their own performance without repeated self-listing.

## Character projections

A character projection is the content of the accepted turn that a particular character experiences. Assemble it in authored order, removing authoring selectors and scopes. Do not send the complete turn to every member of its combined audiences and ask a model to ignore the hidden portions.

**Proposed extension, not yet ratified:** `#Mara(primary|fallback)`.

| Content | Who receives it |
| --- | --- |
| Unscoped text | Base audience and actor. |
| Span primary | Named span recipients and actor. |
| Span fallback, if authored | Base-audience members excluded from that span, except the actor. |
| Span without fallback | Excluded observers receive nothing for that span. |

The actor receives the primary, never an additional fallback performance, including when the actor is also in the base audience. A recipient outside the base receives only the spans naming them, unless they are the actor.

A fallback describes only what those observers can perceive. It is an alternative projection of the same occurrence, not another utterance or event. `[not perceived]` is an available channel-neutral fallback, not an automatic replacement rule. Prefer `[unintelligible]` when an observer notices speech but cannot understand it. Completely unnoticed acts and private thoughts leave no placeholder unless explicitly authored otherwise.

Omit turns with no perceivable content for that observer. Do not expose hidden text, recipient lists, hidden-span counts or source offsets in character prompts, retrieval or memory work. Internal provenance must remain separate from model-visible content. Perception of a claim does not establish its truth or force belief.

## Examples

Visible whisper, words heard only by Mara, using the proposed fallback extension:

```text
@Corin #Mara,Nell He leans in and whispers to Mara: #Mara("The key is under the ferry rope."|[unintelligible]) Then he steps back.
```

Mara and Corin receive:

```text
He leans in and whispers to Mara: "The key is under the ferry rope." Then he steps back.
```

Nell receives:

```text
He leans in and whispers to Mara: [unintelligible] Then he steps back.
```

Nell hears the words but does not see the movement:

```text
@Corin #Mara,Nell #Mara(He leans toward Mara.) "The key is under the ferry rope."
```

Mara and Corin receive the movement and the quote. Nell receives only `"The key is under the ferry rope."`. Keep connective punctuation inside the appropriate span so omission does not strand it.

Private thought with no observer placeholder:

```text
@Corin #Mara,Nell #Corin(I must not tell them about the second key.)
```

Only Corin receives the thought. Mara and Nell receive no turn, including no automatic `[not perceived]` marker.

## Parsing

Use flat audience scopes initially. Balance ordinary parentheses inside a scope; nested audience scopes are invalid. Resolve actor and recipient names to existing IDs before acceptance. Reject unresolved or ambiguous identities and malformed scopes before any commit; never widen delivery to recover.

The following escaping convention is a proposed parser detail for the handoff:

- `\\`, `\(`, `\)`, `\|`, `\#` and `\@` produce literal backslashes, parentheses, pipes and selector characters. Escaped delimiters do not affect parsing. Preserve other backslashes as text.
- An unescaped pipe at a scope's outer depth separates primary from fallback under the proposed extension. Pipes inside balanced ordinary parentheses are text. A second outer-depth separator is invalid; use `\|` for a literal pipe there.
- Without the fallback extension, reject an outer-depth separator as unsupported rather than accepting and delivering it as ordinary text. Do not silently enable the extension.

For example, `#Mara(The mark (two strokes) means A\|B.)` delivers `The mark (two strokes) means A|B.` to Mara and the actor. `#Mara(Use \( here and \) there.)` delivers literal parentheses without changing scope depth.

Identity token rules and the mechanism for enabling the proposed extension still need agreement in Doxvelt. An unresolved base audience must not be invented to route fallback content.

## Acceptance and persistence

Doxvelt owns the composer, canonical turn, branch selection, identity resolution and character projections. Reverie consumes character-specific played source through the existing host boundary; it does not parse these authoring selectors or infer audiences.

The intended host acceptance operation takes the draft, acting identity, selected simulation and branch, expected source revision and visible default snapshot. Before mutation, resolve identities, validate syntax and required audiences, and prepare projections. A changed branch, source revision or default during preparation requires revalidation rather than acceptance with stale context. Cancellation before commit accepts nothing.

Persist the resolved base audience, ordered spans with resolved audience IDs and primary/fallback content, projection interpretation version and resulting character projections with the accepted turn. Preserve existing perception provenance and stable source identities. Later default changes or identity renames must not reinterpret history. Legacy turns retain their existing interpretation; do not reparse old prose as new scope syntax. No schema or host API names are committed by this handoff.

Preserve one atomic, branch-bound commit. A failed commit publishes neither the turn nor a subset of its projections. Do not split spans or fallback text into independent messages. After an uncertain result or restart, recover the accepted turn and its projections before retrying so the same occurrence is not appended twice. A successful turn commit followed by failed memory work leaves the turn saved and memory work pending; retry memory work without repeating acceptance.

## Reverie integration

Both Rust hosts using [`Bridge`](../engine/src/engine.rs) and process hosts using [`source.read`](architecture.md#native-host-protocol) must supply the same character-specific played source. Each included source message carries its existing stable identity, supported role and projected text. Omit an unperceived turn rather than supplying an empty or hidden-span marker. Preserve internal mapping to the accepted turn and existing perception provenance without encoding hidden structure in model-visible metadata.

Use these projections consistently for immediate character context, retrieval cues and episode source. Keep canonical authoring text and audience metadata out of character/model input. The host supplies the character foundation separately and keeps controls and injected recall distinct from played source.

Turn acceptance requires no Reverie reflection callback. When the host later requests `memorize` or `rebuild`, the existing `source.read` and `model.reflect` callbacks operate on the selected character's source. Existing source and revision checks protect memory publication; callback failure, stale source or cancellation preserves previously published memory. See [architecture](architecture.md) and [recall history](recall-history.md). This handoff introduces no Rust or JSON-lines methods, fields, status codes or error codes.

## Acceptance cases for future implementation

These are required behavior checks, not claims of passing runtime tests. Use isolated host source fixtures and deterministic reflection callbacks; exercise both Rust and process integration when implemented.

| Case | Expected result |
| --- | --- |
| Default, turn and span precedence | Default supplies the base unless overridden for this turn; the span replaces that base locally. A turn override never changes the default. |
| Return to base | Shared text after a closing scope returns to the resolved base audience. |
| Multiple recipients | `#Mara,Nell(text)` delivers primary to both and the actor, once each. |
| Recipient outside base | With base Mara, a Nell-only span reaches Nell; surrounding text does not. |
| Visible whisper | The first example produces the exact Mara/Corin and Nell projections above when the fallback extension is enabled. |
| Heard words, unseen movement | The second example omits only the movement for Nell. |
| Private thought | Corin-only thought produces no turn or placeholder for Mara or Nell. |
| Actor-own perception | Actor gets all primary content, including when absent from recipient lists; never also receives fallback. |
| Literal delimiters | Balanced ordinary parentheses and escaped parentheses, pipes, selectors and backslashes preserve literal text. Inner-depth pipes do not start fallback. |
| Invalid input | Missing required base, unresolved/ambiguous identity, unbalanced or nested scope, extra separator or unsupported fallback rejects the whole turn with no mutation or widened delivery. |
| Default/context changes | Later defaults leave stored history unchanged; a branch/context change cannot silently reuse an unreviewed default or accept stale preparation. |
| No hidden metadata | Prompt, retrieval cues and reflection contain only the observer's projection and permitted provenance, with no hidden text, audience lists, span counts or offsets. |
| Atomicity and recovery | Cancellation before commit, failed commit and restart expose no partial turn; uncertain-result retry does not duplicate it. Memory failure after acceptance leaves the saved turn available for a separate retry. |
| Source and memory checks | Changed projected source or stale revisions prevent stale memory publication; callback failure/cancellation preserves previous published memory through both entry points. |
| Legacy source | Existing turns and their provenance keep their original interpretation. |
