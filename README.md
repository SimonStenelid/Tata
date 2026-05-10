# Tata

![Tata](./tata_cover.JPG)

Tata is a small, fluffy white cat who happens to be your personal finance
advisor. She lives in Telegram, keeps your money in a local SQLite database,
and answers free-text questions by writing SQL on the fly. No dashboard, no
web app — just a chat.

## What it is, technically

A single-process Node app: one Telegram bot wired to one Claude loop. The
agent has a small set of tools and a library of **skills** — markdown briefs
the model loads on demand for specific tasks (writing SQL, parsing PDF
statements, looking up market data, managing memory, etc.). Everything —
Q&A, statement ingest, edits, onboarding — runs through the same agent.

### Tools the agent has

- `run_sql(sql)` — single SELECT against the local SQLite DB (read-only, 200-row cap).
- `market_data(...)` — Yahoo Finance: quotes, historicals, search, fundamentals. Prices converted to the user's currency (from `/memories/profile.md`), with originals + FX rate included.
- `apply_changes(...)` — the only write path. Shows a Telegram confirm keyboard before committing inserts, updates, deletes, or raw SQL.
- `memory` — Anthropic's beta memory tool. A per-user virtual filesystem at `/memories/` where the agent stores durable facts about you (profile, goals, preferences, ingest skip-rules, the financial stance you picked).
- `load_skill(name)` — pulls in a markdown skill brief on demand.

### Skills

Each skill is a markdown file in `agent/skills/`. The agent loads the right
one before doing the matching task, instead of carrying every recipe in the
always-on system prompt.

| Skill | When the agent loads it |
| --- | --- |
| `sql-schema` | Before any non-trivial query |
| `ingest-statements` | User sent PDF statements |
| `upload-session` | PDF document blocks present in the turn |
| `market-data` | Live prices, FX, fundamentals |
| `memory-usage` | Reading or writing `/memories` |
| `onboarding` | First-time user or `/onboard` |
| `cards-and-categories` | Adding/renaming/deleting a card or category |
| `skip-rules` | Managing PDF ingest skip rules |
| `write-changes` | Mutating the DB |

### Financial stances

During onboarding the user picks one of six worldviews. The chosen stance is
inlined into the system prompt and applied consistently to all advice and
analysis. Switch any time with `/stance`.

- **FIRE** — extreme savings rate, 25× FI number, index funds
- **FatFIRE** — high earn / high spend, FI without lifestyle cuts
- **Simple Path to Wealth** — JL Collins style: global index, F-You money, calm
- **Rich Dad Poor Dad** — Kiyosaki: assets > income, cashflow, leverage
- **Ramsey Baby Steps** — 7 steps, debt snowball, no credit cards
- **Boglehead** — three-fund portfolio, low cost, stay the course

### Memory

Two layers, both per-user:

- **Transcript** — last 20 turns of the chat, persisted in SQLite, replayed each turn. After 6 idle hours the agent summarises the prior session into `/memories/last-session.md` and resets.
- **Long-term memory** — Anthropic's beta memory tool exposes `/memories/` as a virtual filesystem; the agent writes durable facts there (profile, goals, accounts, skip-rules, the active stance).

## Requirements

- **Node.js ≥ 20** (see `.nvmrc`)
- **pnpm** (`npm install -g pnpm`)
- An **Anthropic API key** — https://console.anthropic.com/
- A **Telegram bot token** — message [@BotFather](https://t.me/BotFather), `/newbot`
- Your **Telegram numeric user id** — message [@userinfobot](https://t.me/userinfobot)

## Setup

```bash
git clone https://github.com/SimonStenelid/Tata.git
cd Tata
pnpm install

cp .env.example .env
# fill in ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN,
# and TELEGRAM_ALLOWED_USER_IDS (your numeric id)

pnpm db:migrate        # create dev.db from prisma/schema.prisma
pnpm db:seed           # seed canonical categories + default cards
pnpm agent:dev         # start the bot with watch reload
```

Then open Telegram, find your bot, and send `/start`. The first message kicks
off onboarding (identity → stance → financial profile).

## Usage

Tata is conversational — just talk to her. Examples:

- "How much did I spend on groceries last month?"
- "Top 5 expense categories this month"
- "What's my AAPL position worth?"
- "Add a Revolut card"
- "Delete the duplicate Amazon transaction from yesterday"

**Importing statements:** send the PDF as a Telegram attachment and tell Tata
which card it's for (e.g. "this is my Amex"). She'll parse it, categorise the
transactions, show you a preview keyboard, and only commit on ✅.

**Commands:**

- `/start` — hello + quick examples
- `/onboard` — redo the setup flow
- `/stance` — switch financial worldview
- `/reset` — clear the chat transcript (keeps long-term memory)
- `/forget` — wipe everything Tata remembers about you

Only Telegram user ids listed in `TELEGRAM_ALLOWED_USER_IDS` can talk to the
bot; everyone else is silently dropped.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm agent` | Run the bot |
| `pnpm agent:dev` | Run the bot with `tsx watch` |
| `pnpm db:migrate` | Apply Prisma migrations (creates `dev.db`) |
| `pnpm db:generate` | Regenerate Prisma client |
| `pnpm db:seed` | Seed categories + default cards |
| `pnpm lint` | `tsc --noEmit` typecheck |

## Schema overview

- `Transaction` — every money movement. `amount` is positive; sign is implied by `type` (INCOME/EXPENSE). `source` is a free-text card/rail label. `importHash` makes re-ingest idempotent.
- `Category` — labels with `kind` (INCOME/EXPENSE).
- `Card` — cards/rails available for ingest. `keyword` is what gets written into `Transaction.source`.
- `Asset` — stocks/funds/crypto/real estate. Live valuation via `market_data`; `manualValue` only for non-ticker assets.
- `Loan` — debts.
- `Conversation` / `Message` — persistent agent transcript.
- `MarketQuote` — persistent market-data cache.
- `MemoryFile` — per-user durable memory (one row per `/memories/*` file).
- `IngestionRun` — log of statement imports.

## Project layout

```
agent/
├── index.ts              # entrypoint (boot bot)
├── config.ts             # env + model id (Sonnet 4.6 by default)
├── agents/tata.ts        # the agent loop
├── prompts/system.ts     # persona, operating model, stance block, skill index
├── tools/                # run-sql, market, apply-changes, load-skill
├── skills/               # markdown briefs (+ stances/*.md)
├── memory/               # transcript, memory tool handlers, stance, summariser
├── db/                   # SQLite helpers (cards, categories, write)
└── telegram/             # grammy bot, upload sessions, confirm callbacks
prisma/
├── schema.prisma
├── seed.ts
└── migrations/
```

For conventions and notes when working on this repo (especially with Claude
Code), see `CLAUDE.md`.

## Contributing

PRs and issues welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). Please run
`pnpm lint` before submitting.

## License

[MIT](./LICENSE)
