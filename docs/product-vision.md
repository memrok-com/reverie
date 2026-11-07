# Reverie product vision

Reverie gives an RPG companion a subjective memory of a shared life. The companion remembers selectively, carries emotional impressions, and develops a sense of familiarity and elapsed time across episodes. Its past remains limited to the fictional point at which the current episode takes place.

A host can keep separate memories for multiple characters. Each engine process serves one character.

## The experience we want

Years after a companion abandoned her, Mara recalls the abandonment vividly while overlooking evidence that he returned to help. Her memory supports a mistaken interpretation without needing Reverie to invent an event.

After episodes spread across several fictional years, Mara carries the feeling that she has known the player for years. This feeling comes from the body of memory, rather than requiring a system prompt to assert it each time. A long relationship does not imply continuous contact or establish events in unplayed gaps.

When the player later starts Mara's origin story, memories and impressions derived from her future are unavailable. Returning to adulthood can make that newly played childhood episode available to memory, even though the original adult dialogue was played without it. Previously played dialogue remains established history.

## Episodes and reflection

An episode is a unit of played source with a stable identity and a position in fictional chronology. The host owns its transcript and determines its boundaries.

The player explicitly asks to memorize an episode. The host then requests reflection and formation of lasting memory. The episode should unfold before Reverie judges the lasting significance of its details. It should not form lasting memories independently after every turn.

The host supplies immediate context from the active episode. Reflection considers the episode as a whole and can relate it to the character's eligible prior memories. The resulting memory is selective and subjective rather than a transcript or exhaustive factual summary.

Before a character turn, the host can ask Reverie for relevant memory and supply it to the character. Selection responds to cues in the ongoing conversation rather than being fixed at episode opening. Retrieval during play and formation of lasting memory at episode end are separate operations.

The player can continue a conversation after memorization and memorize it again. Each successful operation replaces that episode's previous contribution from the full conversation so far and refreshes affected impressions and later reflections. Reflection excludes the prior contribution being replaced and its dependent interpretations as inputs. Failed or cancelled operations preserve the previous published memory. Unchanged relevant inputs report that memory is already current.

The player can withdraw an episode from memory while retaining its transcript. Rebuilding respects this inclusion choice; it does not ingest every existing conversation. Inspection, recall explanation, cancellation, time placement, and explicit rebuilding are also part of the agreed controls.

## Subjectivity and shared history

Subjectivity includes forgotten details, emotional emphasis, biased interpretation, and changes associated with distance in fictional time. The character may retain a feeling while losing the details that produced it. Remembered confidence and factual accuracy can diverge.

Reverie also supports impressions that span memories, such as familiarity, relationship duration, or a recurring feeling. These impressions must respect the same chronology as individual recollections.

The initial scope includes selective forgetting and mistaken interpretation. Reverie does not deliberately generate experiences that never occurred. The roleplaying agent can infer, misinterpret, or hallucinate during play; memory formation must distinguish those statements from directly played events rather than silently promote every belief to objective truth.

The aim is believable subjective memory for roleplay. The first mechanisms combine foundation-guided model reflection with local fading detail and salience-based retrieval. Their quality needs evaluation through sustained play; see [the initial examples](subjective-evaluation.md).

## Fictional chronology

Play order and canonical order are independent. An episode may be played after another conversation while taking place years before it.

Before character generation begins, the adapter needs an unambiguous canonical position for the episode. Gregorian dates and zoned ISO timestamps supply it directly; relative placement against a labeled episode resolves once to an explicit date with a preview. Relative ordering alone does not establish how many years have passed; duration needs additional temporal information.

An episode can include time jumps. Its full canonical interval, including those jumps, must fit between surrounding episodes. Episodes do not interleave: the memory layer does not need to weave individual turns from different conversations into one chronology. Retrieval uses the current fictional point within the episode, so the integration must keep that point current when time advances. The time control supplies explicit jumps; recognition of jumps in ordinary narration is a possible later convenience.

Chronological eligibility applies to memories, aggregate impressions, reflections, and any other memory supplied to the character. A reflection formed using later experiences must not become available in an earlier episode merely because it describes an early event.

Mara can confidently walk through a burning house in one episode and fear fire years later. Both can be canonical. The RPG may eventually establish what happened between them. Reverie preserves room for gaps and does not resolve the apparent contradiction or invent the missing episode.

## Source ownership and rebuilding

The host's transcripts remain the canonical source record. Reverie does not maintain a second transcript archive. It stores derived memory and enough source references to relate that memory to the conversations from which it was formed.

A transcript records what was played and said. A character's mistaken statement or injected recollection within that record is not automatically an objective event in the fictional world. Control messages and injected memory also need to remain distinguishable from episode experience.

Deleting an episode from source and memory requires rebuilding affected memory from the remaining source. Removing one episode's individual memories is insufficient when it also influenced later reflections or relationship impressions. Editing or repositioning source episodes raises the same dependency problem.

The player and RPG own any cascading edits or deletions of surviving source episodes. If a surviving episode still refers to a deleted event, Reverie rebuilds from the remaining source; it does not rewrite that dialogue or decide which other episodes should be removed. The player can change the remaining source if that reference should also disappear.

The engine rereads included source during memorize and rebuild. Explicitly withdraw an episode before removing its source; missing source otherwise fails conservatively. Ordinary rebuild repairs changed contributions and reuses unchanged published memory. A host can explicitly request full regeneration with `force: true`. This resamples model prose and can require explicitly releasing reviewed corrections. Missing or temporarily inaccessible source must remain distinguishable from an intentional deletion.

## Responsibilities

| Owner | Responsibility |
| --- | --- |
| Player and RPG | Played events, perception through narration, continuity, unplayed gaps, a character foundation appropriate to the episode's time, and any cascading source edits or deletions. |
| Host | Character configuration, player interface, canonical transcripts, current episode context, model access, and memory injection before character turns. |
| Reverie | Subjective memory formation, reflection over the body of memory, chronological eligibility, retrieval for each character turn, and rebuilding derived memory after source changes. |

Memory is supplied after the character foundation and adds to it. The system prompt defines identity, personality, and starting background. Its author must adapt that foundation when playing a different life stage. Reverie does not rewrite or police the system prompt.

Preventing future information in Reverie's output is Reverie's responsibility. Preventing future information in unrelated prompts or conversation context belongs to the RPG and integration.

## Delivery and performance

Reverie is a Rust engine that a host can launch as a native executable or link from source. The host supplies the database location so memory persists across engine updates.

Memory inference uses the model configured by the host. The engine validates the reflection and publishes derived memory to embedded SQLite. See the [host protocol](architecture.md).

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
