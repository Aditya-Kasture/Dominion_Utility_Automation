# Dominion Utility Automation

Phase 2 automation for The Dominion Group: a weekly pipeline that pulls the active
property list, routes every utility bill (who pays — Dominion or the tenant),
retrieves BGE and Baltimore Water bills, and executes **approval-gated** payments.

## Workstreams

| WS | What it does | Entry point |
|----|--------------|-------------|
| WS-1 | N8N orchestration — pulls properties from Postgres, builds the WS-2 payload | `scripts/ws1-orchestrate.ts`, `orchestration/n8n/` |
| WS-2 | Routing engine — per-utility PAY/SKIP/EXCEPTION + **mid-cycle proration (Method A)** | `scripts/ws2-route.ts`, `tests/helpers/routingEngine.ts`, `tests/helpers/prorationEngine.ts` |
| WS-3 | BGE portal agent — login (OTP), bill retrieval, **approval-gated payment** | `tests/bge.spec.ts` |
| WS-4 | Baltimore Water agent — login (OTP), bill + period + consumption, **approval-gated payment** | `tests/water.spec.ts` |
| WS-5 | Postgres reconciliation (account↔property mapping) | `scripts/import-*-mapping.ts` |
| WS-6 | Audit log middleware, weekly `run_summary` + Outlook digest, feedback hook | `scripts/ws6-summary.ts`, `scripts/ws6-feedback.ts`, `tests/helpers/outlookAlert.ts` |

Decision rules and the June 12 / June 19 client-call decisions are documented in
[`docs/`](docs/).

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env        # then fill in DB + portal creds + Azure Graph
```

Create the database schema (once). The runner applies every `db/*.sql` in
dependency order using your `.env` connection (idempotent — safe to re-run):

```bash
npm run db:migrate
```

> Creates the orchestration/WS tables (`orchestration_run`, `routing_decision`,
> `payment_*`, `run_summary`, the portal audit logs, and the empty
> `bge_account_property_map` / `water_account_map`) in `public`.

**Data prerequisites** for a non-empty BGE/Water run (separate from the schema):
the source `hub.*` tables (`property`, `unit`, responsibility, baselines) must be
populated, and the account-mapping tables filled via
`npm run import:bge-mapping` / `npm run import:water-mapping`. Pointing at a DB
that already has this data needs no extra step. Check with `npm run db:diagnose`.

## Running

```bash
# Verify (no DB, no browser, no creds):
npm run typecheck
npm run ws2:test            # routing unit tests
npm run ws2:proration-test  # proration unit tests
npm run ws6:test            # WS-6 digest unit tests

# Pipeline:
npm run ws1:run             # build the WS-2 payload from Postgres
npm run ws2:route           # route + prorate + persist decisions
npm run bge:bills           # retrieve BGE bills
npm run water:full          # water login (OTP) + retrieve bills
npm run ws6:summary         # roll up the run + send the Outlook digest

# Payment (approval-gated — see below):
npm run approve:payment -- --run <run_id> --utility water --account <n> --amount <$> --by "Name"
RUN_ID=<run_id> npm run water:pay
RUN_ID=<run_id> npm run bge:pay
```

## Payment safety model

No payment ever fires without an explicit approval. The `pay` modes only submit
for accounts that have a `payment_approval` row for the given `RUN_ID`
(written by `scripts/approve-payments.ts`, a stand-in for the WS-7 approve-link).
Every attempt is recorded in `payment_attempt` with a deterministic
`idempotency_key`, so a re-run can never double-pay. No approval → the account is
logged `SKIPPED_NO_APPROVAL`.

> **Before any live payment run**, confirm the portal Pay-flow selectors with
> `npm run bge:audit` / `npm run water:audit` (HEADLESS=false).

## Notes

- Secrets live only in `.env` (gitignored). `cache/`, `screenshots/`, and
  `node_modules/` are not committed.
- The DB (schemas `hub`/`public`) is the single source of truth — no direct
  AppFolio/Podio API calls.
