# Dominion Phase 2 — Implementation Status Checklist

> Cross-referenced against `Dominion_Phase2_Final_Plan_v3.docx` and the
> June 12 / June 19 client meeting decisions. Updated 2026-06-19 **after** the
> WS-2/3/4 build that implemented the June 19 call decisions.

## June 19 decisions → v4 changes (changelog)

This supersedes the relevant parts of `Dominion_Phase2_Final_Plan_v3.docx` (the v3
`.docx` is left as a historical artifact; these markdown docs are now source of truth):

- **Proration built — Method A only.** Mid-cycle move-in/out splitting is implemented
  (`tests/helpers/prorationEngine.ts`). **Method C (area-under-curve) removed** — bills are a
  single monthly meter read. No longer "deferred".
- **Review/auto-resolve threshold = $10** (was floated at $9; env-overridable).
- **Grace window = 3 days, inclusive.**
- **Bill-back = invoice**; security deposit is last-resort and not modeled.
- **WS-6 moves entirely to Supabase** (Yaseen scope change). WS-2/3/4 logs stay in **Postgres**.
- **Water OTP wired** via Microsoft Graph (shared Outlook mailbox; same path as BGE).
- **WS-3 + WS-4 payment built** — approval-gated (`payment_approval` + manual
  `scripts/approve-payments.ts`) and idempotent (`payment_attempt`). The WS-7 email
  approve-link that writes approvals automatically is still WS-7 scope.

**Legend:** ✅ Done · 🟡 Partial · ❌ Not done

---

## Workstream-level summary

| WS | Workstream | Plan hrs | Status |
|----|-----------|----------|--------|
| WS-1 | N8N Orchestration Layer | 13.0 | ✅ **Complete** |
| WS-2 | Routing Logic Engine | 16.0 | ✅ **Complete** — now incl. Method-A proration (June 19) |
| WS-3 | Playwright BGE Agent | 12.0 | ✅ **Done** — retrieval + approval-gated, idempotent payment (`pay` mode) |
| WS-4 | Playwright Water Agent | 10.0 | ✅ **Done** — retrieval + OTP + approval-gated payment; period dates captured |
| WS-5 | PostgreSQL Reconciliation Layer | 9.0 | 🟡 **Partial** — mapping tables exist, fuzzy-match layer absent |
| WS-6 | Audit Log & Alerting | 9.5 | 🟡 **Partial** — **moving to Supabase** (June 19); tables + Outlook alerts done, no middleware/summary |
| WS-7 | Letters, Work Orders & Batch Report | 11.0 | ❌ **Scaffolded only** — logic + tables, no delivery/report/approval |
| WS-8 | QuickBooks Journal Entry Generator | 7.5 | ❌ **Not started** |

---

## ✅ DONE

### WS-1 — N8N Orchestration (all deliverables)
- N8N workflow JSON in repo; Monday 8AM ET cron (`0 8 * * 1`) — `orchestration/n8n/dominion-weekly-orchestration.json`
- Property source via Postgres (`hub.*` tables) — per June 2026 decision, **no direct AppFolio/Podio APIs** (intentional divergence from plan)
- QuickBooks CSV ingestion with SHA-256 dedup ledger — `tests/helpers/quickbooksIngest.ts`
- Structured `WS2Payload` handoff + run ledger (`orchestration_run`) — `scripts/ws1-orchestrate.ts`
- Failure exit-codes + Outlook alert on halt

### WS-2 — Routing Logic Engine (all deliverables)
- Decision-tree module, 4-way buckets (BGE-pay / Water-pay / Tenant-skip / Exception) — `tests/helpers/routingEngine.ts`
- 17 reason codes; unit tests across all branches — `tests/ws2-routing.spec.ts`
- Writes decisions + `decision_trail` JSONB to Postgres — `db/ws2-routing.sql`

#### Meeting decisions baked into WS-2
- ✅ Gas/electric always tenant; landlord-BGE-on-unit flagged as exception
- ✅ Water always-pay (Baltimore lien) → `WATER_LIEN_PAY`
- ✅ Lifecycle → responsibility (acquiring / renovation / active / disposed)
- ✅ Disposed: water SKIP, BGE EXCEPTION
- ✅ Consumption tiers: adults×10 + children×5; 0–1.5× normal / 1.5–3× letter / >3× letter+work-order
- ✅ Vacant <10 units/qtr (renovation raised to 30 to avoid false flags)
- ✅ Decision-trail summary for **every** property (not just exceptions)
- ✅ Occupancy update stays **manual** (flag + Outlook alert, no auto-write)

### WS-3 — BGE Agent (now incl. payment)
- audit / paperless / bills / **pay** modes; OTP via Microsoft Graph (Outlook mailbox); paperless enrollment with Postgres state; bill retrieval; audit-log integration — `tests/bge.spec.ts`
- **Payment (`pay` mode):** `submitPayment()` runs only for accounts with a `payment_approval` row for the run; idempotent via `payment_attempt.idempotency_key`; logs `payment` action. No approval → `SKIPPED_NO_APPROVAL`.

### WS-6 — Audit & Alerting (partial set)
- `bge_portal_audit_log` + `water_portal_audit_log` tables exist
- **Outlook** email alerting with batched anomaly/exception context — `tests/helpers/outlookAlert.ts`

---

## 🟡 PARTIAL

- **WS-4 Water agent** — login + **OTP (Graph)** + bill retrieval + tiered consumption + **approval-gated payment (`pay` mode)** + bill-period capture (`period_start`/`period_end`) done. Paperless permanently skipped (no portal toggle). PM-alert / work-order dispatch remain **logged-only** by design (June 19) — not auto-dispatched.
- **WS-5 unified address key** — mapping tables (`bge_account_property_map`, `water_account_map`) exist, but no dedicated unified-key column/index
- **WS-5 routing checks mapping first** — lookup exists; unmatched rows logged to JSONL but not routed into an exception list
- **WS-6 feedback hook** — table **exists** (`routing_feedback`, `db/ws2-routing.sql:95`, index at :104) and is referenced by the alert builder; the **UI/endpoint** that writes to it is not yet built
- **WS-7 work orders** — `work_order_request` table + staging logic exist, no delivery/dispatch
- **WS-7 decision-trail "flowchart"** — computed + serialized to DB, but **no UI/report rendering**

---

## ❌ NOT DONE (the real remaining build)

### WS-3 / WS-4 payment — ✅ DONE (June 19 build)
- ✅ Approval-gated `submitPayment()` in both agents (`payment_approval` gate)
- ✅ Idempotency keys for payments (`payment_attempt.idempotency_key`)
- ✅ WS-4 water OTP (Graph, shared mailbox)
- ⏳ *By design, deferred:* WS-4 PM-alert + work-order API **dispatch** (anomalies logged, not auto-sent — June 19). The **selectors** for the portal Pay flows are best-guess and need an `audit`-mode confirmation pass before a live run.

### WS-5 reconciliation
- Fuzzy matching with configurable confidence threshold (default 90%)
- Unresolved-address surface table
- Per-run address confidence log

### WS-6 alerting
- Reusable audit-log **middleware module** (currently ad-hoc `logBGERun`/`logWaterRun` in `tests/helpers/db.ts`)
- Weekly summary record generator (referenced in alert body, no generator/table)
- *(Slack webhook — superseded by Outlook per June 19; treat as N/A, not a gap)*

### WS-7 — Letters / Work Orders / Batch Report (biggest gap)
- Tenant notification letters (mail-merge/template engine)
- Color-coded Excel batch report (green/yellow/red) — `xlsx` only used for *reading* imports today
- Email delivery to Jack with single-use **Approve link**
- Approval-token table + persistence
- N8N polling for approval token → fires payment-mode runs
- Feedback button/UI (the "leave feedback on logic" Yaseen requested)

### WS-8 — QuickBooks Journal Entry Generator (entirely absent)
- IIF/CSV journal-entry **generation** (note: `scripts/import-quickbooks.ts` is WS-1 *ingestion*, not this)
- Chart-of-accounts / property→expense mapping table
- Consolidated entry per run
- Email to accountant
- Audit log of file generation

### Cross-cutting
- ✅ **Proration** for mid-cycle move-ins — **built (Method A)**: `tests/helpers/prorationEngine.ts`,
  wired into `routeProperty`, persisted to `proration_result` / `proration_override`,
  unit-tested in `tests/ws2-proration.spec.ts`. Method C dropped (no sub-period data).
  Remaining wiring: source tenant move-in/out dates from Abdul's Postgres (column names TBC).

---

## Critical-path read

The **decision brain (WS-1 + WS-2, now incl. proration) is done** and the **execution tail
(WS-3 + WS-4 payment) is built and approval-gated**. Remaining for a fully-automated weekly cycle:

1. **WS-7 approve-link + N8N poll** — the *automatic* writer of `payment_approval`. Until it exists,
   payments are authorized manually via `scripts/approve-payments.ts` (the gate itself is done, so
   WS-3/WS-4 payment is exercisable today).
2. **Portal Pay-flow selector confirmation** — run `bge:audit` / `water:audit` to lock the live Pay
   selectors before a production payment run (current selectors are best-guess).
3. **Proration data wiring** — source tenant move-in/out dates from Abdul's Postgres.
4. **WS-8** QuickBooks export (greenfield); **WS-5 fuzzy match** + **WS-6 → Supabase** hardening.

This matches the June 19 call: WS-3/WS-4 are now *pay-capable* (not just retrieve), gated so no
unapproved payment can fire; the WS-7 approve-link and WS-8 are the next build.
