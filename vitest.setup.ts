import { existsSync } from "node:fs";

// Tests use the same database settings as `next dev`.
// Variables already set in the environment (e.g. in CI) win.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
