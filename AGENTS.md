# Reverie working conventions

## Engine and host boundary

- Reverie owns subjective memory, chronology, reflection validation and retrieval. Hosts own the player interface, canonical transcripts and branch selection, character foundations, model access and credentials.
- Treat the complete host operation as part of each feature. Specify its inputs, source and reflection callbacks, results, cancellation and recovery behavior through the Rust API and JSON-lines protocol.
- Give hosts enough information to explain model work, data changes and affected corrections before they request a mutation. Keep status and error codes stable and document changes to the public contract.
- Keep publication atomic and protect it with source and revision checks. Failed or cancelled reflection preserves previously published memory.
- Distinguish complete success from partial completion. If a date change is saved but a subsequent rebuild fails, expose the saved state and pending work so the host can retry the rebuild without repeating the date change.
- Use plain language and familiar story concepts in public documentation. Document protocol identifiers and implementation details where hosts need them to integrate correctly.

## Verification and review

- Review changed operations through their supported Rust and process entry points. Use isolated databases, authored source fixtures and deterministic model callbacks. Changes to real memories or a running host process require the user's authorization.
- Add meaningful protocol and behavior tests for changed decisions and side effects. Cover cancellation before mutation, callback failure, stale source or revisions, atomic publication, restart and safe retry where applicable.
- In pull requests, describe the resulting host operation and the checks performed. State any runtime or platform checks that remain unverified.
