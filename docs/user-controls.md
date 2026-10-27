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
| `/reverie memorize` | Form or replace the episode's contribution from its selected full branch. |
| `/reverie memory` | Inspect included episodes, source freshness, and recollections available at the current story point, with provenance. |
| `/reverie explain` | Show memory supplied for the selected character reply and its sources, including after restart. |
| `/reverie unmemorize` | Withdraw this episode while keeping its chat. Refresh dependent memory. |
| `/reverie rebuild` | Re-reflect surviving included episodes using their selected branches. |
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

After a folder is linked, explicit `/model` selections, model cycling and thinking-level changes are saved for that folder. Reverie restores the provider, model and thinking level for new/resumed sessions, restart and reload. The widget shows the active thinking level, and memory formation uses it too. Pi adjusts unsupported levels to the model's capabilities. Existing model preferences adopt the current thinking level the first time they are loaded after the update. Restoration does not change Pi's global defaults. An unavailable saved model pauses generation and preserves the submitted text; it never silently substitutes another provider. Use `/reverie model` to save the current choice even when it is already selected, or to choose a replacement. Unlinked folders keep Pi's normal model and thinking behavior.
