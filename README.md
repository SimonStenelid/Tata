# Tata

![Tata](./tata_cover.JPG)

In a quiet corner of your phone, between the messages from friends and the
weather forecast, there lives a small white cat named Tata. She does not
say much at first. She waits, the way cats do, until you tell her about
your money — what came in, what went out, what you are saving for, what
keeps you up at night.

She is not a spreadsheet. She is not an app with charts that ask to be
loved. She is a cat, and she listens. You send her a bank statement and
she reads it overnight, sorting each little expense into its proper jar.
You ask her, in plain words, where the month went, and she tells you. You
tell her you want to retire by the sea one day, and she remembers, and
quietly bends her advice toward that horizon.

She lives entirely on your own machine. Nothing about your money leaves
the room. She is yours.

## Getting started

The simplest way is the guided installer. It will help you create a
Telegram bot, paste in an API key, and prepare Tata's little house — all
from one terminal window.

```bash
git clone https://github.com/SimonStenelid/Tata.git
cd Tata
./setup.sh
```

The installer will walk you through, step by step:

1. **An Anthropic API key.** This is what gives Tata her voice. Sign in
   at [console.anthropic.com](https://console.anthropic.com/), create a
   key, and paste it when asked.
2. **A Telegram bot.** Open Telegram, message
   [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and
   username. BotFather hands you a token — paste that too.
3. **Your Telegram user id.** Message
   [@userinfobot](https://t.me/userinfobot) and it replies with a number.
   That number is the key to Tata's door; only ids on the list can talk
   to her.
4. **The database.** The installer creates a local SQLite file and seeds
   the default categories and cards. You don't have to do anything.

When it finishes:

```bash
pnpm agent:dev
```

Then open Telegram, find your bot, and send `/start`. Tata will introduce
herself and walk you through onboarding — your name, your currency, the
financial worldview you want her to follow, and a quick sketch of where
your money lives. After that, just talk to her.

<details>
<summary>Or set it up by hand</summary>

```bash
pnpm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN,
# and TELEGRAM_ALLOWED_USER_IDS (your numeric id)
pnpm db:migrate        # create dev.db from prisma/schema.prisma
pnpm db:seed           # seed canonical categories + default cards
pnpm agent:dev         # start the bot
```

</details>

## What Tata can do

At her heart, Tata does one thing very well: she keeps track of every
krona, dollar, or yen that moves through your life, and she answers any
question you have about them.

### Talk to her like a person

There is no menu, no dashboard, no forms. You just write what's on your
mind:

- "How much did I spend on groceries last month?"
- "What's my biggest expense category this year?"
- "How much have I saved since January?"
- "What's my AAPL position worth right now?"
- "Did I spend more on coffee or on books in March?"

She writes the query, reads the answer, and explains it back in plain
language.

### Send her your statements

Export a PDF from your bank or card and send it to Tata as a Telegram
attachment. Tell her which card it's for ("this is my Amex") and she'll
read every line, sort each transaction into the right category, and show
you a preview. Nothing gets saved until you tap ✅. If she keeps
miscategorising your favourite bakery as "restaurants," tell her once and
she'll remember.

### She tracks everything, so you can analyse anything

Every transaction lives in a small SQLite file on your machine. Income,
expenses, assets, loans, recurring subscriptions — all of it. Because
it's all in one place, you can ask sweeping questions: how your spending
has changed year over year, what your real savings rate is, which months
were unusually expensive, what your net worth looks like today versus six
months ago. This is what Tata is for.

### Pick a worldview

During onboarding you pick one of six financial stances. Tata applies it
consistently to every piece of advice — so her tone matches the way you
already think about money.

- **FIRE** — high savings rate, index funds, the 25× rule
- **FatFIRE** — financial independence without giving up the good life
- **Simple Path to Wealth** — JL Collins style: one global index, calm
- **Rich Dad Poor Dad** — Kiyosaki: assets over income, cashflow, leverage
- **Ramsey Baby Steps** — debt snowball, no credit cards, seven steps
- **Boglehead** — three-fund portfolio, low cost, stay the course

Switch any time with `/stance`.

### Made for people who don't love finance

You don't need to know what an ETF is. You don't need to enjoy
spreadsheets. You don't need a system. Send Tata your statements when
you remember to, talk to her when something's on your mind, and she'll
quietly keep your finances tidy in the background. The goal is for
anyone — no matter how little they care about money — to end up on top
of theirs.

### Slash commands

| Command | What it does |
| --- | --- |
| `/start` | Hello + a few example questions |
| `/onboard` | Redo onboarding (name, stance, profile) |
| `/stance` | Switch your financial worldview |
| `/reset` | Clear the chat transcript (long-term memory is kept) |
| `/forget` | Wipe everything Tata remembers about you |

Only Telegram user ids in `TELEGRAM_ALLOWED_USER_IDS` can talk to her.
Everyone else is silently ignored.

## Under the hood

A short tour for the curious.

### Stack

- **Node.js 20+**, TypeScript, single process
- **[grammY](https://grammy.dev/)** for the Telegram bot
- **Claude Sonnet 4.6** via the Anthropic SDK for the agent loop
- **SQLite** via `better-sqlite3`, schema managed by **Prisma**
- **Yahoo Finance** for live prices and FX

### How it's wired

One Telegram bot, one Claude loop. The agent has a small set of tools
and a library of markdown **skills** it loads on demand — instead of
stuffing every recipe into one giant prompt.

The tools:

- `run_sql(sql)` — read-only `SELECT` against the local DB
- `market_data(...)` — quotes, historicals, FX, fundamentals
- `apply_changes(...)` — the only write path; Telegram asks you to
  confirm before any insert, update, or delete
- `memory` — Anthropic's beta memory tool; a per-user virtual
  filesystem at `/memories/`
- `load_skill(name)` — pulls in a markdown brief for a specific task

Skills live in `agent/skills/` (SQL schema, statement ingest, market
data, onboarding, cards & categories, and so on).

### Memory

Two layers, both per-user, both local:

- **Transcript** — the last 20 turns of your chat, persisted in SQLite.
  After 6 idle hours, Tata summarises the session into
  `/memories/last-session.md` and starts fresh.
- **Long-term memory** — `/memories/` as a virtual filesystem the agent
  reads and writes (your profile, goals, accounts, skip-rules, active
  stance).

### Requirements

- Node.js ≥ 20 (see `.nvmrc`)
- pnpm (`npm install -g pnpm`)
- An Anthropic API key
- A Telegram bot token + your numeric user id

### Project layout

```
agent/
├── index.ts              # entrypoint
├── config.ts             # env + model id
├── agents/tata.ts        # the agent loop
├── prompts/system.ts     # persona, operating model, stance, skill index
├── tools/                # run-sql, market, apply-changes, load-skill
├── skills/               # markdown briefs (+ stances/*.md)
├── memory/               # transcript, memory tool handlers, summariser
├── db/                   # SQLite helpers
└── telegram/             # grammY bot, upload sessions, confirm callbacks
prisma/
├── schema.prisma         # Transaction, Category, Card, Asset, Loan, …
├── seed.ts
└── migrations/
scripts/
└── setup.ts              # the guided installer
```

For deeper notes on conventions (especially when working on this repo
with Claude Code), see [`CLAUDE.md`](./CLAUDE.md).

## Scripts

| Command | What it does |
| --- | --- |
| `./setup.sh` | Guided first-time setup |
| `pnpm setup:cli` | The installer alone (skips the bash prerequisite checks) |
| `pnpm agent` | Run the bot |
| `pnpm agent:dev` | Run the bot with `tsx watch` |
| `pnpm db:migrate` | Apply Prisma migrations (creates `dev.db`) |
| `pnpm db:generate` | Regenerate Prisma client |
| `pnpm db:seed` | Seed categories + default cards |
| `pnpm lint` | `tsc --noEmit` typecheck |

## Contributing

PRs and issues welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). Please
run `pnpm lint` before submitting.

## License

[MIT](./LICENSE)
