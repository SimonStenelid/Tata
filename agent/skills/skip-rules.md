# skip-rules

Manage the user's ingest skip rules. Each rule is a substring; any future
`Transaction.description` that contains it (case-insensitive) is silently
dropped during PDF ingest — never staged, never inserted.

Rules live in the per-user `memory` virtual filesystem at
`/memories/ingest-skip.md`. One merchant substring per line. `#` starts a comment.

## File format

```
# Merchants to skip during PDF ingest. One per line; case-insensitive substring match.
swish
internal transfer
löneutbetalning
```

## Workflow

To **list** current rules: `memory.view /memories/ingest-skip.md`.

To **add** a rule: read the file via `memory.view`, then `memory.str_replace`
or `memory.insert` to append a new line. If the file doesn't exist yet, create
it via `memory.create` with the header comment plus the first rule.

To **remove** a rule: `memory.str_replace` the line out (replace `"<rule>\n"` with `""`).

After any change, summarise the new rule list back to the user in chat so they
can sanity-check.

## Common patterns

- "Stop ingesting Swish transfers" → add `swish`.
- "Ignore my own savings transfers" → ask the user for the exact merchant text
  on those rows; add the most specific substring that catches them all.
- "What rules do I have?" → `memory.view /memories/ingest-skip.md` and pretty-print.
