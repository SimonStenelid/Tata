# memory-usage

The `memory` tool exposes a per-user virtual filesystem rooted at `/memories`.
This is YOUR notebook about this user — separate from the chat transcript,
which is short and gets trimmed.

## When to write

After a user message reveals a durable fact, write or update a file. Suggested layout:

- `/memories/profile.md` — basic personal context (city, salary cadence, household size).
- `/memories/goals.md` — financial goals + target dates (e.g. "save 200k SEK by 2027 for a kitchen reno", "FIRE by 50").
- `/memories/preferences.md` — answer style, risk tolerance, currencies they think in.
- `/memories/accounts.md` — brokerage/bank/card context not in the DB (broker names, pension setup, target allocations).
- `/memories/notes/<topic>.md` — anything else, one topic per file.
- `/memories/ingest-skip.md` — user-managed merchant skip rules. See the skip-rules skill before touching this.

## When NOT to write

- Don't store transient state (today's question, last query result) — that's the transcript's job.
- Don't store anything the DB already answers (transactions, balances, asset rows, current category list).

## How to write

- Prefer `str_replace` / `insert` for surgical updates over rewriting whole files.
- If a stored fact contradicts a new user statement, update it — trust the user.
- Use markdown headings + bullets so files stay greppable later.

## Workflow at the start of every conversation

1. Call `memory` with `command: "view", path: "/memories"` to see what's already known.
2. `view` any files that look relevant before answering.

If the user references something they "told you before," memory is where to look.
