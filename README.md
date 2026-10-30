# Redaction Action

Document ingestion, parsing, and review.

## Stack

- **Next.js 16** (App Router, Cache Components) with React 19 and TypeScript
- **Tailwind CSS 4**
- **Postgres 16** through **Drizzle ORM** (`postgres` driver)
- **Vitest** for tests, GitHub Actions for CI

## Getting started

Requires Node 24+, pnpm, and Postgres 16 (a local install or Docker).

```bash
pnpm install
cp .env.example .env.local      # then set DATABASE_URL for your machine
createdb redaction_action       # or: docker compose up -d
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000. The home page shows whether the database is reachable, and `GET /api/health` returns the same check as JSON.

## Scripts

| Command            | What it does                                     |
| ------------------ | ------------------------------------------------ |
| `pnpm dev`         | Start the dev server                             |
| `pnpm build`       | Production build                                 |
| `pnpm lint`        | ESLint                                           |
| `pnpm typecheck`   | Generate route types and run `tsc`               |
| `pnpm test`        | Run Vitest once (uses the database in `.env.local`) |
| `pnpm db:generate` | Create a migration from changes to `src/db/schema.ts` |
| `pnpm db:migrate`  | Apply pending migrations                         |
| `pnpm db:studio`   | Open Drizzle Studio to browse the database       |

## Layout

```
src/app/            Routes and UI
src/app/api/health  Database health check
src/db/schema.ts    Table definitions
src/db/index.ts     Database client
drizzle/            Generated SQL migrations
```
