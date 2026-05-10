# Contributing

Thanks for your interest in Tata. This is a small personal project shared as
open source — contributions are welcome but please keep them focused.

## Before opening a PR

1. Read `CLAUDE.md` — it documents the conventions used here.
2. Run `pnpm lint` (typecheck must pass).
3. Keep changes surgical. Don't refactor adjacent code that isn't part of
   the change.
4. For non-trivial changes, open an issue first to discuss the approach.

## What's in scope

- Bug fixes
- New ingest sources (banks, card formats)
- New agent tools that fit the "agent-first" model
- Schema improvements (with migration)

## What's out of scope

- Web dashboards / UI surfaces (intentionally not a goal)
- Alternative chat frontends beyond Telegram, unless behind a clean adapter

## Security

If you find a security issue, do not open a public issue. Email the
maintainer instead.
