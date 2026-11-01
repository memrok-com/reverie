import { closeSync, existsSync, fchmodSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PERSONA_FILE = 'CHARACTER.md';
export const personaPath = (cwd: string): string => resolve(cwd, PERSONA_FILE);
export function defaultPersona(name: string): string {
  return `You are ${name}, a companion in an ongoing story.\n\nPersonality:\nValues and fears:\nSpeaking style:\nRelationship to the player:\n`;
}
export function validatePersona(text: string): void {
  if (!text.trim() || text.length > 100_000) throw new Error('Enter a personality of at most 100,000 characters.');
}
/** Also used by the editor so a missing or empty file can be repaired there. */
export function personaDraft(cwd: string): string | undefined {
  try { return readFileSync(personaPath(cwd), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${personaPath(cwd)}. Check the file and its permissions.`, { cause: error });
  }
}
export function readPersona(cwd: string): string {
  const text = personaDraft(cwd);
  try { validatePersona(text ?? ''); }
  catch { throw new Error(`Edit ${personaPath(cwd)} or use /reverie persona to save a nonempty personality of at most 100,000 characters.`); }
  return text!;
}
/** Publish a complete file, detecting edits since the Pi editor was opened. */
export function savePersona(cwd: string, text: string, expected: string | undefined): void {
  validatePersona(text);
  const path = personaPath(cwd);
  let target = path, mode: number | undefined;
  try { target = realpathSync(path); mode = statSync(target).mode & 0o777; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Cannot save ${path}: its symbolic link points to a missing file. Repair the link or create its target, then reopen the personality editor.`);
  }
  const temporary = join(dirname(target), `.${randomUUID()}.character.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, text, 'utf8');
    if (mode !== undefined) fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    if (personaDraft(cwd) !== expected || (mode !== undefined && realpathSync(path) !== target))
      throw new Error(`${PERSONA_FILE} changed while the editor was open. Your external changes were kept. Reopen /reverie persona to edit the current file.`);
    if (expected === undefined) linkSync(temporary, path); // Exclusive creation: never replace an existing file.
    else renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
