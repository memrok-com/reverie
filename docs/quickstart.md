# Playing with Reverie in Pi

Reverie adds character roleplay and subjective memory to an existing Pi installation. The verified build is Windows x64, Pi 1.3.0, Node 24.9–24.x.

## Install

Keep the supplied release folder somewhere stable, then run:

```powershell
pi install C:\path\to\reverie-pi
```

Start Pi or run `/reload`. For development, the release directory is `dist/reverie-pi` after `npm run build`. An archive must be extracted before installing it as a local directory. Local package references point to that directory; moving or removing it breaks the reference. npm publication is pending, so the registry install spelling is not available yet.

The engine starts automatically from the installed package. You do not configure an executable path or a second model provider. Installing the extension does not activate roleplay in unlinked folders.

## Create or link a character

1. Start Pi in the character's folder.
2. Run `/reverie setup`.
3. Create a character or choose an existing memory. The folder's name is suggested for a new character.
4. Write the personality in the multiline editor and save it.

The association uses a stable character identity, so names do not act as database keys. Other folders may link to the same character. Their chats become episodes for that character. A folder's current link cannot change the owner of an existing chat; start `/new` when switching characters.

Use `/reverie` or Ctrl+Alt+M for the menu. Personality changes apply to the next character reply. Linked folders use the character personality and turn off Pi's coding tools; unlinking restores the original tool selection.

Choose the model once with `/reverie model` (also available as **Model for this folder** in the menu). Subsequent explicit `/model` selections and thinking-level changes are saved automatically for this linked folder. The provider, model and thinking level are restored across new chats, resumed sessions, restart and `/reload`, without changing Pi's global defaults. The widget shows the active thinking level; memory formation uses it too. Unsupported thinking levels are adjusted to the model's capabilities. If the model becomes unavailable, generation pauses instead of falling back to another provider. Existing linked folders can initialize their saved choice with `/reverie model`.

Reverie uses the selected model for reflection without copying its credentials to the memory engine. The widget identifies its provider and model so similarly named models such as `default` are distinguishable.

## Play and remember

Use one chat per episode. Set its fictional date with the menu or:

```text
/reverie when 2010-01-01 The lighthouse
```

If you write an opening message first, Reverie asks for the date before generation. Cancelling restores the opening text in the editor. A leading ISO date in the opening can establish the date directly. Dates are never inferred from the computer clock.

You can correct the date repeatedly before the first player message. Dated, unplayed chats are saved when you leave or close them and appear in Pi's `/resume`. Use **Episode chats** in the Reverie menu, or `/reverie chats`, to resume or delete episodes, including older date-only setups without a saved chat file.

The widget above the composer shows the character, date, memory state, and selected reply. To remember the episode at its current ending:

```text
/reverie memorize
```

The command returns while memory formation runs, leaving cancellation available. A visible notice confirms completion or failure. Continuing and memorizing again replaces the episode's contribution from the full selected story. It does not count the same episode twice.

## Reply alternatives

- Ctrl+Alt+R: generate again from the latest user message, including after a failed first generation.
- Ctrl+Alt+Left / Ctrl+Alt+Right: cycle existing alternatives.
- `/reverie reroll`, `/reverie previous`, `/reverie next`: equivalent commands.

Alternatives are Pi branches. Selection is saved so it survives restart. Only the selected branch is source for memorization. Alternative navigation does not summarize rejected replies into the selected story. Shortcuts are editable through `/reverie keys`; run `/reload` after saving changes. Conflicting terminal or Pi shortcuts may need remapping.

## Memory and deletion

The menu provides inspection, recall explanation, enable/disable, linking, withdrawal, rebuild, cancellation, and deletion. Memory off pauses memory use and formation while keeping the personality active. Unlinking retains the stored character and memories.

`/reverie delete` confirms deletion, opens a fresh chat, removes the old session file, and removes its memory contribution. Later dependent recollections and impressions are invalidated immediately without a model call. Rebuild forms them again from surviving included episodes.

Deleting a known session through Pi's `/resume` picker or outside Pi is detected while Reverie is running, on startup, and before recall. Pending deletion cleanup is durable. When Pi is closed, cleanup happens the next time the extension runs. Absence is treated as deletion only for files whose identity was previously recorded; access errors are not interpreted as deletion.

## Data and backups

By default, Reverie stores `catalog.sqlite` and `memory.sqlite` under `~/.pi/agent/reverie/`. `PI_CODING_AGENT_DIR` relocates that root together with Pi's agent directory. This data is outside the installed package and survives upgrades/removal. Close Pi before backing up the database files so their journals settle.

Pi owns the original session files. The catalog stores their paths and selected branch identities, not another transcript archive. Keep sessions for rebuilding. Pi normally stores them centrally by working directory; its `sessionDir` setting can place them inside a character folder.

Existing DSH databases and chats are preserved. They are not silently connected to Pi: their source identities and host format differ.
