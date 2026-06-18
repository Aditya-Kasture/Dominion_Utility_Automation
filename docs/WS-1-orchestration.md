# WS-1 — N8N Orchestration Layer

Owner: Aditya Kasture · Phase 2 · Status: implemented

Every Monday 08:00 ET, N8N fires the weekly run: pull the active property list,
ingest any new QuickBooks exports, and hand a single structured payload to the
Routing Logic Engine (WS-2). No payment occurs in this layer — it only assembles
and hands off the week's facts.

## Components

| Piece | File | Role |
|-------|------|------|
| N8N workflow export | `orchestration/n8n/dominion-weekly-orchestration.json` | Cron trigger → orchestrate → IF gate → WS-2 / WS-6 |
| Orchestrator entry point | `scripts/ws1-orchestrate.ts` | Invoked by N8N; builds + persists the WS-2 payload |
| Property/Podio sources + WS-2 contract | `tests/helpers/propertySources.ts` | DB adapters and the `WS2Payload` type WS-2 imports |
| QuickBooks folder watcher | `tests/helpers/quickbooksIngest.ts` | Idempotent CSV ingestion into `qb_csv_import` |
| DB migration | `db/ws1-orchestration.sql` | `orchestration_run` + `qb_csv_import` tables |

## Setup

1. Apply the migration (after `base-schema.sql` + `migrations.sql`):
   ```
   psql "$DATABASE_URL" -f db/ws1-orchestration.sql
   ```
2. Fill the new `.env` values: `DOMINION_PROJECT_DIR`, `OUTLOOK_WEBHOOK_URL`
   (a Power Automate HTTP-trigger flow that emails the ops Outlook mailbox —
   replaces the former Slack webhook), and optionally `QB_CSV_DIR`,
   `PODIO_OVERRIDE_TABLE`.
3. Import `orchestration/n8n/dominion-weekly-orchestration.json` into N8N and set
   `DOMINION_PROJECT_DIR` + `OUTLOOK_WEBHOOK_URL` in the N8N host environment.
4. Smoke test without touching the DB or N8N: `npm run ws1:dry-run`
   (skips the run ledger; still queries property data and writes `cache/ws1-latest.json`).
   Real run: `npm run ws1:run`.

## Exit contract (read by the N8N IF node)

| Exit | Run status | N8N action |
|------|-----------|------------|
| `0` | `SUCCESS` | Proceed to WS-2 routing |
| `2` | `EMPTY` (no active properties) | WS-6 Outlook alert, halt |
| `1` | `FAILED` (DB/API/creds error) | WS-6 Outlook alert, halt |

On any non-zero exit the script prints one JSON line to **stderr** —
`{ "run_id": "...", "status": "FAILED", "error": "..." }` — which the N8N
Outlook alert node (Power Automate HTTP-trigger flow → email to the ops
mailbox) surfaces directly.

## AppFolio field mappings (source: `hub` / `public` schema)

AppFolio data is synced into Postgres by Dominion; WS-1 reads it there (the same
tables Phase 1 uses). Decided June 2026: there will be **no direct AppFolio or
Podio API integration** — Abdul's Postgres is the single source of truth for
all upstream data. The `WS2Payload` contract is the stable interface.

| WS-2 payload field | Source column | Notes |
|--------------------|---------------|-------|
| `property_id` | `hub.property.id` | |
| `property_name` | `hub.property.name` | |
| `address.{street1,city,state,zip}` | `hub.property.street1/city/state/zip` | |
| `lifecycle_stage` | `hub.property.lifecycle_stage` | raw AppFolio stage, passed through |
| `occupancy` | derived from `lifecycle_stage` | hint only — see mapping below |
| `responsibility.water` | `hub.unit_utility_responsibility` where `utility_type='water'` | rolled up per property |
| `responsibility.bge` | same, where `utility_type IN ('bge','electric','gas')` | live data uses `bge`; rolled up per property |
| `bge_accounts[]` | `public.bge_account_property_map.bge_account_number` | by `property_id` |
| `water_accounts[]` | `public.water_account_map` (`unit_id`, `water_account_number`) | unit name from `hub.unit` |
| `consumption_baselines[]` | `hub.unit_consumption_baseline` | `utility_type`, `period_unit`, `baseline_amount` |

**Responsibility roll-up** (priority order, landlord-side wins): `dp` → `landlord`
→ `included_in_rent` → `tenant` (only if every unit is tenant) → `unknown`. These
are the real values seen in `hub.unit_utility_responsibility`. WS-2 owns the actual
pay/skip decision — WS-1 only reports the facts.

**Occupancy mapping** (assumption — confirm with Abdul). Live `lifecycle_stage`
values and how WS-1 maps them:

| lifecycle_stage | occupancy | reasoning |
|-----------------|-----------|-----------|
| `active` | `occupied` | property in active rental service |
| `acquisition`, `renovation`, `rent_ready` | `vacant` | pre-lease / not yet rented → landlord-responsible |
| `disposed` | `disposed` | no longer owned |
| `null` / other | `unknown` | surfaced to WS-2 for review |

The raw `lifecycle_stage` is always included so WS-2 can override this hint.

## Podio field mappings (manual overrides — optional)

The Podio overrides table is not pinned down in Phase 1, so this path is
defensive and config-driven. Set:

| Env var | Meaning | Default |
|---------|---------|---------|
| `PODIO_OVERRIDE_TABLE` | `podio.<table>` carrying a `title` column (property address/name) | unset → `source: absent` |
| `PODIO_OVERRIDE_FIELD` | the override text column on that table | `override` |

Overrides are matched to properties on a normalized address/name key and land in
`PropertyRoutingInput.manual_overrides[]`. A missing/misconfigured table logs a
warning and the run continues — overrides never fail the weekly run.

## QuickBooks Desktop CSV ingestion

The watcher scans `QB_CSV_DIR` for `*.csv`, fingerprints each by SHA-256, and
records previously unseen files in `qb_csv_import`. Re-dropping an identical file
is a no-op; an edited file (new hash) re-ingests. WS-1 only stages arrivals —
mapping QB rows into journal entries is WS-8. Unset `QB_CSV_DIR` skips this step.

## Handoff payload (the WS-2 contract)

Written to `cache/ws1-payload-<run_id>.json` and mirrored to `cache/ws1-latest.json`:

```jsonc
{
  "run_id": "ws1-2026-06-08T1200Z",
  "generated_at": "2026-06-08T12:00:03.114Z",
  "source": { "appfolio": "db", "podio": "absent", "quickbooks_csv_ingested": 0 },
  "property_count": 128,
  "properties": [
    {
      "property_id": 42,
      "property_name": "1025 N Carey",
      "address": { "street1": "1025 N Carey St", "city": "Baltimore", "state": "MD", "zip": "21217" },
      "lifecycle_stage": "renovation",
      "occupancy": "vacant",
      "responsibility": { "bge": "landlord", "water": "landlord" },
      "bge_accounts": ["11000160703"],
      "water_accounts": [{ "unit_id": 88, "unit_name": "1", "water_account_number": null }],
      "consumption_baselines": [{ "unit_id": 88, "utility_type": "water", "period_unit": "quarterly", "baseline_amount": 18.5 }],
      "manual_overrides": []
    }
  ]
}
```

WS-2 imports the `WS2Payload` / `PropertyRoutingInput` types from
`tests/helpers/propertySources.ts` and reads `cache/ws1-latest.json`.
