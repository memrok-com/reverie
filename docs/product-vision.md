# Reverie product vision

Reverie gives an RPG companion a subjective memory of a shared life. The companion remembers selectively, carries emotional impressions, and develops a sense of familiarity and elapsed time across episodes. Its past remains limited to the fictional point at which the current episode takes place.

The player plays a character substantially based on themselves. One agent plays a companion or NPC alongside them. Multiple characters may have separate stored memories, but only one character is active during runtime.

## The experience we want

Years after a companion abandoned her, Mara recalls the abandonment vividly while overlooking evidence that he returned to help. Her memory supports a mistaken interpretation without needing Reverie to invent an event.

After episodes spread across several fictional years, Mara carries the feeling that she has known the player for years. This feeling comes from the body of memory, rather than requiring a system prompt to assert it each time. A long relationship does not imply continuous contact or establish events in unplayed gaps.

When the player later starts Mara's origin story, memories and impressions derived from her future are unavailable. Returning to adulthood can make that newly played childhood episode available to memory, even though the original adult dialogue was played without it. Previously played dialogue remains established history.

## Episodes and reflection

An episode is a single chat or conversation. Its first player message implicitly starts it. An episode is not a folder; a folder may instead represent an RPG or a character, with the exact mapping still open.

An episode has an explicit ending that triggers reflection and formation of lasting memory. The agreed memorize action is documented under the recommended name `/reverie memorize` in [user controls](user-controls.md). The episode should unfold before Reverie judges the lasting significance of its details. It should not form lasting memories independently after every turn.

The active conversation supplies immediate context through Pi. Reflection considers the episode as a whole and can relate it to the character's eligible prior memories. The resulting memory is selective and subjective rather than a transcript or exhaustive factual summary.

Before each character turn, Reverie retrieves and injects memory relevant to the next response. Selection responds to cues in the ongoing conversation rather than being fixed at episode opening. Retrieval during play and formation of lasting memory at episode end are separate operations.

The player can continue a conversation after memorization and memorize it again. Each successful operation replaces that episode's previous contribution from the full conversation so far and refreshes affected impressions and later reflections. Reflection excludes the prior contribution being replaced and its dependent interpretations as inputs. Failed or cancelled operations preserve the previous published memory. Unchanged relevant inputs report that memory is already current.

The player can withdraw an episode from memory while retaining its transcript. Rebuilding respects this inclusion choice; it does not ingest every existing conversation. Inspection, recall explanation, cancellation, time placement, and explicit rebuilding are also part of the agreed controls.

## Subjectivity and shared history

Subjectivity includes forgotten details, emotional emphasis, biased interpretation, and changes associated with distance in fictional time. The character may retain a feeling while losing the details that produced it. Remembered confidence and factual accuracy can diverge.

Reverie also supports impressions that span memories, such as familiarity, relationship duration, or a recurring feeling. These impressions must respect the same chronology as individual recollections.

The initial scope includes selective forgetting and mistaken interpretation. Reverie does not deliberately generate experiences that never occurred. The roleplaying agent can infer, misinterpret, or hallucinate during play; memory formation must distinguish those statements from directly played events rather than silently promote every belief to objective truth.

The aim is believable subjective memory for roleplay. The first mechanisms combine foundation-guided model reflection with local fading detail and salience-based retrieval. Their quality needs evaluation through sustained play; see [the initial examples](subjective-evaluation.md).

## Fictional chronology

Play order and canonical order are independent. An episode may be played after another conversation while taking place years before it.

Before character generation begins, the adapter needs an unambiguous canonical position for the episode. The first release uses Gregorian dates or zoned ISO timestamps through the time control; relative placement against labeled episodes can follow later. Relative ordering alone does not establish how many years have passed; duration needs additional temporal information.

An episode can include time jumps. Its full canonical interval, including those jumps, must fit between surrounding episodes. Episodes do not interleave: the memory layer does not need to weave individual turns from different conversations into one chronology. Retrieval uses the current fictional point within the episode, so the integration must keep that point current when time advances. The time control supplies explicit jumps; recognition of jumps in ordinary narration is a possible later convenience.

Chronological eligibility applies to memories, aggregate impressions, reflections, and any other memory supplied to the character. A reflection formed using later experiences must not become available in an earlier episode merely because it describes an early event.

Mara can confidently walk through a burning house in one episode and fear fire years later. Both can be canonical. The RPG may eventually establish what happened between them. Reverie preserves room for gaps and does not resolve the apparent contradiction or invent the missing episode.

## Source ownership and rebuilding

Pi chat transcripts remain the canonical source record. Reverie does not maintain a second transcript archive. It stores derived memory and enough source references to relate that memory to the conversations from which it was formed.

A transcript records what was played and said. A character's mistaken statement or injected recollection within that record is not automatically an objective event in the fictional world. Control messages and injected memory also need to remain distinguishable from episode experience.

Deleting an episode from source and memory requires rebuilding affected memory from the remaining source. Removing one episode's individual memories is insufficient when it also influenced later reflections or relationship impressions. Editing or repositioning source episodes raises the same dependency problem.

The player and RPG own any cascading edits or deletions of surviving source episodes. If a surviving episode still refers to a deleted event, Reverie rebuilds from the remaining source; it does not rewrite that dialogue or decide which other episodes should be removed. The player can change the remaining source if that reference should also disappear.

The first integration rereads included source during memorize/rebuild. Explicitly withdraw an episode before removing its source; missing source otherwise fails conservatively. Ordinary rebuild repairs changed contributions and reuses unchanged published memory. Pi's separate **Regenerate with current model** action previews the model route and included episode count before confirmation; native clients can explicitly request the same full regeneration with `force: true`. This resamples model prose and can require explicitly releasing reviewed corrections. Missing or temporarily inaccessible source must remain distinguishable from an intentional deletion.

## Responsibilities

| Owner | Responsibility |
| --- | --- |
| Player and RPG | Played events, perception through narration, continuity, unplayed gaps, a character foundation appropriate to the episode's time, and any cascading source edits or deletions. |
| Pi | Character configuration, conversation interface, canonical transcript storage, current conversation context, and model configuration. These are capabilities to reuse through the adapter where supported. |
| Reverie | Subjective memory formation, reflection over the body of memory, chronological eligibility, retrieval for each character turn, and rebuilding derived memory after source changes. |
| Adapter | Connect Pi sources and commands to Reverie, provide current temporal and character identity inputs, supply model access, and inject relevant memory before each character turn. |

Memory is supplied after the character foundation and adds to it. The system prompt defines identity, personality, and starting background. Its author must adapt that foundation when playing a different life stage. Reverie does not rewrite or police the system prompt.

Preventing future information in Reverie's output is Reverie's responsibility. Preventing future information in unrelated prompts or conversation context belongs to the RPG and integration.

## Delivery and performance

Reverie first targets Windows with a portable native executable, without an installer. The Pi bundle starts it automatically and stores derived memory under Pi home, so plugin updates do not move the data. Pi and model-serving requirements are separate from this portability promise.

Memory inference uses the model configured in Pi through access supplied by the adapter. Reverie does not choose whether inference is local or remote. The implementation uses a native Rust engine with embedded SQLite and a TypeScript Pi extension, installed with Pi's package manager and configured through its terminal controls; see [architecture](architecture.md).

Retrieval and injection happen before each character turn and should add little delay to play. Reflection and rebuilding may take longer. Retrieval uses no model inference. The performance target is below 50 ms at the 95th percentile with 10000 derived memories on the development machine.

## Behavior examples

- A lighthouse mentioned halfway through an episode can cue a relevant recollection before the character's next response, even if the opening message did not mention it.
- An origin episode receives neither memories of later episodes nor impressions formed from those later experiences.
- Episodes played years apart in fictional time can support a sense of a long relationship without inventing encounters in the intervening gaps.
- A time jump stays within its episode's chronological slot and changes the fictional point used for subsequent retrieval.
- Memorization considers the completed episode rather than committing lasting memories after every turn.
- Continuing after memorization and memorizing again replaces the episode's prior contribution; repeating the action with unchanged inputs leaves memory unchanged.
- Withdrawing an episode preserves its transcript and keeps it excluded during rebuilding until it is explicitly memorized again.
- Deleting an episode immediately removes its direct memory and invalidates later dependent derivatives; rebuilding restores memory from surviving included episodes. References still present in surviving played dialogue remain a source concern for the player and RPG.

## Reuse before implementation

Build the subjective memory behavior and the adapter where existing capabilities fall short. Reuse Pi for its existing functions, and assess existing memory components before choosing new implementation work.

Pi documents [extension commands and lifecycle hooks](https://pi.dev/docs/latest/extensions) and its [append-only session tree](https://pi.dev/docs/latest/session-format). The adapter verifies these against Pi 1.3.0 through executable checks. Reverie's withdrawal retains a chat, while deletion removes its contribution and invalidates dependent memory.
