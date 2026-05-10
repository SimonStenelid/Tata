# Tata

![Tata](./tata_cover.JPG)

Agent-first personal finance helper. A Telegram bot backed by Claude that
answers free-text questions by writing SQL against a local SQLite database,
and ingests bank/card PDF statements into that same database.

There is no web UI — the schema and tools are designed for the agent to
consume directly.

## How it works

Two Claude loops share one SQLite DB:

- **Q&A loop** — receives Telegram messages, uses a `run_sql` tool (read-only)
  plus a `market_data` tool (Yahoo Finance) plus Anthropic's beta `memory`
  tool to answer questions about your finances.
- **Ingest loop** — receives PDF uploads via `/add <card>` + `/go`, parses
  transactions in three phases (stage → categorize → confirm → insert),
  deduplicating via a UNIQUE `importHash`.

See `agent/` for the source and `prisma/schema.prisma` for the data model.

## Requirements

- **Node.js ≥ 20** (see `.nvmrc`)
- **pnpm** (`npm install -g pnpm`)
- An **Anthropic API key** — https://console.anthropic.com/
- A **Telegram bot token** — message [@BotFather](https://t.me/BotFather), run
  `/newbot`, follow the prompts
- Your **Telegram numeric user id** — message [@userinfobot](https://t.me/userinfobot)

## Setup

```bash
git clone <your-fork-url> tata
cd tata
pnpm install

cp .env.example .env
# edit .env — fill in ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN,
# and TELEGRAM_ALLOWED_USER_IDS (your numeric id)

pnpm db:migrate        # create dev.db from prisma/schema.prisma
pnpm db:seed           # seed canonical categories + default cards
pnpm agent:dev         # start the Telegram bot with watch reload
```

Then open Telegram, find your bot, and send `/start`.

## Commands

In Telegram:

- `/start` — help
- `/reset` — clear conversation memory for the current chat
- `/add <keyword>` — start a PDF upload session for a card (e.g. `/add debit`,
  `/add amex`, or `/add debit amex` to combine). Keywords come from the
  `Card` table; add new ones by inserting rows (or ask the agent).
- `/go` — parse uploaded PDFs, preview categorized transactions, then insert
- `/cancel` — abort an upload session

Anything else is treated as a free-text question and answered by the agent.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm agent` | Run the bot |
| `pnpm agent:dev` | Run the bot with `tsx watch` |
| `pnpm db:migrate` | Apply Prisma migrations (creates `dev.db`) |
| `pnpm db:generate` | Regenerate Prisma client (`src/generated/prisma`) |
| `pnpm db:seed` | Seed categories + default cards |
| `pnpm lint` | `tsc --noEmit` typecheck |

## Schema overview

- `Transaction` — every money movement. `amount` is always positive; sign is
  implied by `type` (INCOME/EXPENSE). `source` is a free-text card/rail label
  (`Handelsbanken`, `Amex Platinum`, `Swish`, `Cash`). `importHash` makes
  re-ingest idempotent.
- `Category` — labels with `kind` (INCOME/EXPENSE).
- `Card` — cards/rails the user can ingest from. `keyword` is what the user
  types after `/add` and what gets written into `Transaction.source`.
- `Asset` — stocks/funds/crypto/real estate. Live valuation via the
  `market_data` tool; `manualValue` is only for non-ticker assets.
- `Loan` — debts.
- `Conversation` / `Message` — persistent agent transcripts.
- `MarketQuote` — persistent market-data cache.
- `MemoryFile` — per-user durable memory (Claude `/memories/` virtual FS).
- `IngestionRun` — log of statement imports.

## Project layout

```
agent/
├── index.ts            # entrypoint
├── config.ts           # env + source labels
├── agents/             # Claude loops — tata.ts (Q&A), ingest.ts (PDF)
├── prompts/            # system prompts
├── tools/              # run-sql, market_data, ingest tools
├── memory/             # transcript + memory tool + skip rules
├── db/                 # SQLite helpers
└── telegram/           # grammy bot, upload sessions, reminders
prisma/
├── schema.prisma
├── seed.ts
└── migrations/
```

For deeper guidance on conventions used here (and notes for using Claude Code
to work on this repo), see `CLAUDE.md`.

## Contributing

PRs and issues welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). Please run
`pnpm lint` before submitting.

## License

[MIT](./LICENSE)
