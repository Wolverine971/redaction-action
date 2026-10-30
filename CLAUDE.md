@AGENTS.md

# Redaction Action

Take-home project: ingest documents, parse them, and review the results.

## Stack

Next.js 16 (App Router) + React 19 + TypeScript, Tailwind 4, Postgres 16 via Drizzle ORM (`postgres` driver), Vitest. Package manager is pnpm.

## Commands

- `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`
- Schema change: edit `src/db/schema.ts`, then `pnpm db:generate` and `pnpm db:migrate`. Never hand-edit files in `drizzle/meta`.

## Conventions

- `cacheComponents` is on: pages are static by default. Anything that reads the database or request data must sit inside `<Suspense>` (call `await connection()` first for DB reads), or `next build` fails.
- Import the database as `import { db } from "@/db"`. It reads `DATABASE_URL` from `.env.local`.
- Tests run against the same local database as `next dev`. CI runs lint, typecheck, migrate, test, and build against a Postgres service container.
