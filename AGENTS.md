# Reverie working conventions

## Product experience

- Treat the complete user journey as part of each feature: consider the number of screens, the amount of text, the next action, and how the user recovers from failure.
- Keep routine flows compact. Prefer a single clear decision when it can cover the operation and its required follow-up work. Additional screens should serve a distinct user need.
- Show the information needed for the current decision. Put explanations, technical details, and exhaustive impact lists behind an optional details action.
- Make the primary action explicit. Avoid an information screen that the user must dismiss merely to reach a second confirmation of the same action.
- Show warnings about model costs, data changes, or removed corrections only when they apply to the operation being confirmed. Keep those consequences visible even when other details are optional.
- Complete necessary follow-up work automatically within the confirmed scope. For longer work, show progress and support cancellation.
- Distinguish complete success from partial completion. If a date or another change was saved but follow-up work failed, state what is saved, what remains pending, and offer a retry that does not repeat the completed change.
- Use plain language and familiar story concepts in player-facing text. Keep internal identifiers and implementation terminology out of the main flow unless the user needs them to make a decision.

## Verification and review

- Review changed interactive flows at a normal terminal size, including keyboard navigation, readable text, clear primary actions, cancellation, and failure recovery. Use isolated test data; do not interrupt a user's active Pi session or alter real memories to validate a change without their authorization.
- Add meaningful interaction tests for changed decisions and side effects, including cancellation before mutation, automatic follow-up work, and safe retry where applicable.
- In UI-related pull requests, briefly describe the resulting user journey and the UX checks performed. State any visual or runtime checks that were not performed; automated behavior tests alone do not establish that the rendered flow is clear.
