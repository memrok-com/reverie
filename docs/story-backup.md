# Character story backups

Use `/reverie backup [new-file.zip]` in a linked folder, or **Story backup → Export character story** in the Reverie menu. The operation captures one character and uses the current folder's memory/model preferences. It refuses to replace an existing backup file.

Restore with `/reverie restore [file.zip]` from an unlinked folder or **Restore character backup** in the unlinked menu. Restore preserves the character and episode identities and refuses existing-character, episode or reply collisions. To restore a second copy of the same character, use another Pi agent data directory/installation. No existing story is overwritten. The restored folder is linked and a fresh chat opens; use **Episode chats** to resume a restored episode.

## Contents and portability

Format version 2 is a ZIP with a JSON story manifest, its SHA-256 integrity record, and Pi session files with individual SHA-256 fingerprints. It adds chronology offsets; older releases reject it instead of silently restoring incorrect branch dates. This release also imports version-1 archives. It includes:

- Character name, identity and personality.
- Original played entries and alternatives, their entry identities and selected leaves.
- Episode labels, complete fictional intervals, cumulative branch date shifts, inclusion/withdrawal state and invalidated/stale states. Older archives without a date shift restore with zero offset.
- Published recollections, broader-impression snapshots, reviewed corrections, dependencies and source references.
- Historical reply-context explanations, and the exporting folder's memory switch and provider/model/thinking preference.

Pi source remains canonical. The ZIP is a snapshot; it does not become a live transcript store. Restore writes Pi sessions below the destination Reverie data directory's `restored/` folder and rewrites only machine-specific session headers. Internal parent-session links are relocated; parent links outside the backed-up character are omitted. A state-only selection anchor ensures Pi opens the archived branch even if another branch was last appended to the file. Played entries, their IDs and dialogue are preserved. Source selection and memory inspection do not depend on the original absolute paths.

An active date-only setup is captured from Pi's in-memory session without writing an extra live source file. Other episodes need readable original source; recover a legacy date-only setup through **Episode chats** before backing it up. Unavailable or changing source fails the backup with an actionable error.

Provider credentials, account configuration, environment variables, unrelated characters, original folder links and global shortcut preferences are not exported. A saved model name is a preference, not an authentication bundle. An unavailable model pauses generation after restore until `/reverie model` selects an available replacement; inspecting source and memory still works.

## Consistency and failure handling

The current window must be idle, with no memory operation running. Backup takes short catalog/native write locks to capture metadata and the last published contributions, releases them while reading source, then reacquires them to verify that the complete snapshot still matches. Other windows can write unrelated stories during source I/O; changes to this story's memory or selection abort the backup with a retry message. Registered source bytes are also checked again before completing capture. No model is called by export or restore validation.

Restore verifies format, integrity, ownership, branch references and size limits, then validates the story in an isolated native database. Only after validation does it publish both database changes. Errors roll back both databases and remove staging files. A restore journal lets startup resolve an interruption between the two database commits: a fully committed story is retained, and an incomplete import is removed. Ownership uses an exclusive SQLite lock released automatically on process exit, so a reused PID cannot defer recovery. Empty/truncated journals left before publication are discarded after acquiring that lock; their unknown staging directories may remain harmlessly unreferenced. A live restore, including a journal still being written, is left alone. Small restore-lock database files remain in the data directory for safe reuse.

Archives and expanded content are limited to 256 MiB, individual files to 64 MiB, and sources to 10,000. Unknown paths, duplicate entries, damaged source and unsupported format/session versions are rejected before publication. Keep the original ZIP until the restored episodes and selected branches have been reviewed.
