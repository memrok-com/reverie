# Reverie ubiquitous language

Use these terms to discuss Reverie's behavior and its boundary with the RPG and host. They describe product concepts rather than a committed database schema. Terms marked proposed still need agreement.

## Characters and sources

| Term | Meaning |
| --- | --- |
| Player | The human taking part in play. |
| Character | The fictional person whose subjective memory Reverie serves. |
| Agent | The runtime that plays the character through a model. Prefer character when discussing fictional experience. |
| Character foundation | The system prompt defining identity, personality, and starting background. Maintained outside Reverie and appropriate to the episode's life stage. |
| RPG | The fictional setting and ongoing play in which the player and character participate. It owns narrative continuity and what happens in unplayed gaps. |
| Conversation | The host's chat or dialogue used as the played source for an episode. |
| Episode | A unit of played source with a stable identity and a place in fictional chronology. Continued play can change its source and replace its memorized contribution later. |
| Transcript | The host-owned canonical record of a conversation. It can contain dialogue, narration, mistaken beliefs, injected context, and controls; those are not interchangeable as evidence of fictional events. |
| Source reference | An identity relating derived memory to its originating episode or source messages, without storing a second transcript archive. Inspection presents episode labels; internal provenance retains host-supplied source identities. |

## Time and continuity

| Term | Meaning |
| --- | --- |
| Canon | The established fictional history. Reverie does not repair apparent inconsistencies in it. |
| Play order | The order in which the player actually plays conversations. |
| Canonical order | The order in which episodes take place inside the fiction. It can differ from play order. |
| Canonical position | An episode's place in the fictional chronology, supplied before memory is injected for play. An explicit date or zoned ISO timestamp, entered directly or resolved once from an episode-relative date with a preview. |
| Canonical interval | The span of fictional time occupied by an episode, including its time jumps. Episode intervals do not interleave. |
| Current fictional point | Where the ongoing scene takes place within the episode's interval. Retrieval uses this point for chronological eligibility and temporal distance. |
| Time jump | An advance in fictional time within an episode that stays in its chronological slot between surrounding episodes. The time control supplies a date or zoned ISO timestamp explicitly. |
| Fictional time | Time within the story, used to reason about duration and distance from experiences. |
| Elapsed fictional time | The duration between fictional points. Episode order by itself does not establish this duration. |
| Temporal anchor | Proposed: a supplied date or temporal reference used to place an episode and, where possible, determine elapsed fictional time. |
| Episode label | A recognizable title used to identify an episode, particularly when placing other episodes relative to it. |
| Gap | An interval or missing part of established history that has not been played or supplied. It does not authorize Reverie to invent intervening events. |
| Eligible memory | Memory belonging to the active character that can exist at the current fictional point, without depending on later experiences or later interpretations. |

## Subjective memory

| Term | Meaning |
| --- | --- |
| Experience | What the character encounters in play. The RPG supplies what the character can perceive. |
| Interpretation | Meaning the character attributes to an experience. It may be biased or wrong and does not establish objective truth. |
| Memory | A lasting subjective representation formed from experience through reflection, with selective detail and emotional emphasis. |
| Body of memory | The character's collection of memories and the broader impressions derived from them, as available at a particular fictional point. |
| Reflection | Model-assisted consideration of a completed episode and eligible prior memory to form or revise lasting memories and broader impressions. It is distinct from in-character thought during each turn. |
| Recollection | What becomes available to the character from memory in the current situation. Relevant memory is retrieved and injected before each character turn. |
| Impression | Proposed: a broader subjective sense derived across experiences, such as long familiarity, recurring distrust, or emotional distance. It need not be a recollection of one event. |
| Distortion | Selective loss, emphasis, or altered interpretation that makes memory differ from the source experience. Initial scope excludes deliberate invention of events that never happened. |
| Bias | A tendency affecting what a character retains, emphasizes, or interprets. The first release reflects the character foundation and played behavior rather than maintaining a separate numeric bias model. |
| Emotional salience | Proposed: the significance an experience or detail has for the character's feelings, which can affect its place in memory. |
| Forgetting | Reduced availability or detail in subjective memory. It does not imply deletion of canonical source. |

## Operations and integration

| Term | Meaning |
| --- | --- |
| Memorize | The explicit action that establishes the episode's current ending and forms or replaces its derived contribution from the full conversation so far. |
| Episode contribution | The derived memory originating from an episode. Repeated memorization replaces it and refreshes dependent reflections instead of counting the experience again. |
| Included episode | An episode explicitly selected to contribute to memory through successful memorization. A rebuild preserves this selection. |
| Unmemorize | Withdraw an episode's contribution and refresh affected derived memory while retaining its transcript. It remains excluded until explicitly memorized again. |
| Retrieval | Selecting eligible memory relevant to the character's next response before each character turn. It should be fast enough to preserve conversational flow. |
| Injection | Supplying retrieved memory to the agent's context after its character foundation and before each character turn. |
| Rebuild | Recreating affected derived memory from the current source after deletion or other relevant changes. It does not rewrite previously played dialogue. |
| Episode deletion | Intentional removal of an episode from source and derived memory, including its influence on reflections. It is distinct from hiding a chat or ordinary forgetting. |
| Cascade editing or deletion | Changes to other source episodes needed after an episode is changed or removed. The player and RPG own these changes; Reverie rebuilds from the resulting source. |
| Adapter | The host's connection to Reverie. It supplies character and temporal inputs, played source, and model reflection. |
| Active character | The single character whose memories are served during a runtime. Other characters can have separately stored memory. |

## Examples that constrain the terms

An origin story played fourth can be first in canonical order. It must not receive future memories or impressions, even if those impressions refer back to childhood.

Mara's fear of fire in adulthood and confidence around fire in childhood can both belong to canon. The gap between them belongs to the RPG; Reverie does not supply a causal event.

Forgetting the words of an argument while retaining its humiliation is distortion. Deleting the episode containing the argument is source removal and requires a rebuild.

Feeling that a friendship is years old is an impression across the body of memory. It does not establish frequent contact or invented shared adventures during those years.

If episode B still contains dialogue referring to deleted episode A, rebuilding memory from B may preserve that reference as a belief. Deciding whether to edit or delete B belongs to the player and RPG.
