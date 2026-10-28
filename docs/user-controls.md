# Reverie controls in Pi

Run `/reverie` or Ctrl+Alt+M to open the character and memory menu.

| Command | Behavior |
| --- | --- |
| `/reverie setup` | Create a character or link an existing memory to the current folder. |
| `/reverie link` | Choose an existing character memory. |
| `/reverie unlink` | Unlink this folder, retaining its stored character memory. |
| `/reverie persona` | Edit the linked character's personality in the terminal. |
| `/reverie model` | Select and save a model for this character folder, without changing Pi's global default. |
| `/reverie on` / `off` | Enable or disable memory retrieval and formation. Personality remains active. |
| `/reverie when [date] [label]` | Set fictional time, or open date input. A visible confirmation and widget show the result. |
| `/reverie chats` | List the character's dated episodes and resume or delete one, including unplayed setups. |
| `/reverie memorize` | Form or replace the episode's contribution from its selected full branch, then review the actual published recollections and broader impressions. |
| `/reverie memory` | Complete stored recollections and episode states, plus a clearly labeled retrieval sample at the current story point. |
| `/reverie memory browse` | Select an episode to read every published recollection, inspect broader impressions separately, follow played sources, correct an item, or resume its chat. Also available through **Inspect memory** in the menu. |
| `/reverie memory episode [id]` | Open sources, corrections and inspection actions directly for the current episode, or the ID shown after memorization. |
| `/reverie memory impressions` / `sources` | Choose an episode's broader-impression snapshot or supporting played text, with player/companion authorship. |
| `/reverie memory eligible [date]` | All stored recollections eligible at the active story point, or an explicit date, independently of cue and recall limits. |
| `/reverie memory correct` | Choose a published recollection, edit its meaning/detail/feeling/source references, and review dependent invalidation before applying. |
| `/reverie explain` | Show memory supplied for the selected character reply and its sources, including after restart. |
| `/reverie unmemorize` | Withdraw this episode while keeping its chat. Refresh dependent memory. |
| `/reverie rebuild` | Repair affected included episodes using their selected branches, preserving unchanged published contributions. |
| `/reverie cancel` | Cancel the ongoing memory operation without replacing the last published memory. |
| `/reverie reroll` | Generate a reply to the latest user message, including retrying a failed or interrupted first generation. |
| `/reverie previous` / `next` | Cycle saved alternatives, without generating another reply. |
| `/reverie keys` | Configure shortcuts; reload to apply. |
| `/reverie delete` | Confirm deletion of this saved chat and its memory contribution. |

Default shortcuts: Ctrl+Alt+R rerolls; Ctrl+Alt+Left/Right cycles; Ctrl+Alt+M opens the menu. They preserve an unsent text draft. Reroll requires an idle session and a user message; cycling also requires a saved character reply. If generation failed because of authentication or connection settings, correct those or select another model before retrying.

Before the first player message, you can correct the story date as often as needed, moving it earlier or later with `/reverie when` or **Story date** in the menu. Each correction replaces the episode's starting date. Once play begins, date changes must move forward; an earlier episode needs a new chat. Dates must still fit a separate chronological slot from other episodes.

Dated chats with no played turns are saved when you leave or close them, so Pi's `/resume` can find them. **Episode chats** in the Reverie menu also lets you resume or delete any dated episode. It can recover an older date-only setup that has no saved chat file, retaining its identity and date without adding dialogue. **Delete this chat** also works before the first turn. Memory inspection calls unmemorized episodes **Not memorized**; this describes their memory contribution, not whether they can be resumed.

Commands, UI notices and injected recollections are excluded from played source. Only explicit memorization forms lasting memory. Deletion invalidation is immediate and requires no model; rebuilding later dependent memory does require one.

Empty recall sends no memory text to the model. Actual recollections are provided as private background in the character's system context, never as user dialogue or a fabricated assistant reply. `/reverie explain` still shows exactly which recollections were supplied.

Inspection is for the player. It can show future episodes without supplying them to the character or saving them into played history. Stored detail is shown in full even when it would fade in recall. Eligibility is chronological; it does not mean an item was selected or supplied to a reply. Broader impressions identify contributing episodes; supporting played text retains literal actions and dialogue and identifies who authored each turn. Stale source references are shown as references to the published branch, with current source freshness reported separately.

A published empty contribution, an episode that was never memorized, a stale contribution, and invalidated memory that needs rebuilding have distinct labels. Source unavailability is reported without discarding the published contribution.

Corrections preserve played dialogue and intentional subjectivity. Applying one saves the reviewed episode recollections, clears that episode's impressions, invalidates all later contributions, and releases later correction snapshots that depended on the old memory. The preview lists these changes; no model is needed to apply them. Rebuild afterward to regenerate dependent impressions and episodes. Ordinary rebuilding reuses unchanged earlier contributions so sampled model output cannot change the correction's dependencies. Corrections survive restart and withdrawal/re-memorization while source and earlier memory remain unchanged. If either changes, rebuilding stops until you select **Release correction** in the episode browser and approve its invalidation preview. Releasing removes that episode's contribution and leaves its inclusion choice intact. Existing reply explanations remain historical. Changing the model or thinking level still invalidates reflection fingerprints and can require releasing a correction; issue #7 tracks that separate behavior. See the [correction contract](memory-inspection.md).

After a folder is linked, explicit `/model` selections, model cycling and thinking-level changes are saved for that folder. Reverie restores the provider, model and thinking level for new/resumed sessions, restart and reload. The widget shows the active thinking level, and memory formation uses it too. Pi adjusts unsupported levels to the model's capabilities. Existing model preferences adopt the current thinking level the first time they are loaded after the update. Restoration does not change Pi's global defaults. An unavailable saved model pauses generation and preserves the submitted text; it never silently substitutes another provider. Use `/reverie model` to save the current choice even when it is already selected, or to choose a replacement. Unlinked folders keep Pi's normal model and thinking behavior.
