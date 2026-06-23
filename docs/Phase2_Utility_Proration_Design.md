# Mid-Cycle Move-In / Move-Out Utility Proration — Design Note

> **Status (updated 2026-06-19, post-call): BUILT — Method A.** The open questions
> below were resolved on the June 19 call and **Method A (daily average) is now
> implemented** (`tests/helpers/prorationEngine.ts`, wired into
> `tests/helpers/routingEngine.ts`, persisted to `proration_result` /
> `proration_override`). **Method C (area-under-the-curve) is ruled out** — Jack
> confirmed Baltimore water + BGE bills expose only a single monthly meter read,
> so there is no daily/weekly curve to integrate. This document is kept as the
> rationale; the **Decisions locked on the call** box immediately below is the
> source of truth.
>
> ### Decisions locked on the June 19 call
> | Item | Decision |
> |------|----------|
> | Method | **A (daily average) only.** Method C removed (no sub-period data). |
> | Grace window | **3 days, inclusive** (`graceDays=3`). ≥4 days → real split. |
> | Review / auto-resolve threshold | **$10** (`reviewThresholdDollars=10`, env-overridable; accountants can change). |
> | Bill-back mechanism | **Invoice.** Security deposit is last-resort and **not modeled** — just create the invoice. |
> | Rounding | Bias **toward not over-charging the tenant** (`roundingBias=tenant_favor`, whole dollars). |
> | Override | Human override always wins; **computed + final value + who + why** logged (`proration_override`). |
> | Log store | **Postgres** (not Supabase). |
> | Renovation | Renovation-window usage stripped from the tenant share (`renovationExcludesTenant=true`). |

---

## 1. The problem in plain English

Every utility bill covers a **fixed window of dates** — say **May 1 → May 31**. But people don't
move in or out on the 1st of the month. A tenant might take the keys on **May 15**. Now the May
bill covers **two different "owners":**

- **May 1–14** — the unit was vacant / being renovated → **Dominion's** cost.
- **May 15–31** — the tenant is in → **tenant's** cost.

The question is simple to ask and annoying to answer: **how much of that one bill belongs to whom?**

### Why this matters for water but is mostly a non-issue for BGE

This is the single most important point for Jack, and it's good news: **the two utilities behave
completely differently.**

- **BGE (gas & electric) — usually nothing to reconcile.**
  BGE accounts get switched **in and out of the tenant's name on the move date.** When my team does
  their job, the tenant calls BGE, puts the account in their name on move-in day, and we hand over
  the keys. So BGE is a **"whose name is on the account"** question, not a **"how many dollars"**
  question. If the tenant turns it on in their name on the move-in date, **they own 100% of the
  consumption from that date forward — there is nothing to split.** The only mismatch is when the
  dates are a day or two off, which Jack called "arguing over pennies."

- **Water — Dominion always pays, then bills back, so the split is unavoidable.**
  Baltimore water is a **lien against the property**, so the water account **stays in Dominion's
  name the entire time we own it.** We always pay the full water bill, then bill the tenant back for
  *their* share. That means we have to compute the tenant's share on **both ends** — the move-in
  bill **and** the move-out bill. At each end you get a "stub": consumption sits near zero, then
  jumps up when the tenant moves in (or drops to zero when they leave). **That stub is exactly the
  piece we have to attribute correctly.**

### The renovation twist (the case that actually bites)

Here is the scenario that motivated the whole conversation:

> A property is **under renovation May 1–14** — crews running water, flushing lines, lots of usage.
> A tenant moves in **May 15.** The water bill arrives for **May 1–31.**

If we naïvely say *"tenant was in when the bill came, so the tenant pays the whole thing,"* we
**overcharge the tenant for the construction water.** The construction usage was front-loaded into
the part of the month they weren't even there. So the shape of usage across the month matters — not
just the move-in date.

### Worked example (the numbers Jack used)

- Typical disputed amount on one bill: **~$9.** Worst case Aditya floated: **~$70.**
- Per bill, that's small — Jack: *"if I paid 20 bucks of their first month's utility, it's not
  going to murder them."*
- **But** we run this across **~933 properties**, on a recurring cycle, on both move-in and move-out.
  Pennies × 933 × every cycle **adds up** — which is exactly why Aditya wants to get it right rather
  than bake a human "eyeball it" error into the automation.

So the design has to balance **accuracy vs. effort**, and that trade-off depends entirely on **how
detailed the bill data is** — which we have not yet confirmed (see §6).

---

## 2. Where the system stands today (honest starting point)

> **Superseded 2026-06-19:** the engine now prorates via Method A. The paragraph
> below describes the pre-call state and is kept for context. Today
> `prorationEngine.ts` takes the bill period + occupancy timeline (move-in/out +
> renovation) and returns `{ tenant_share, dominion_share, method_used,
> needs_review, … }`; WS-4 scrapes the bill period dates (`period_start` /
> `period_end` on `water_portal_audit_log`). The only remaining wiring item is
> sourcing the tenant move-in/out dates from Abdul's Postgres (column names TBC).

Right now the routing engine does **not** prorate anything, and does **not** look at bill date
ranges at all. It does the simplest possible thing:

- It takes **one total consumption number** for the whole billing period.
- It compares that number to a **flat threshold** (e.g. vacant "normal" is under 10 units/quarter;
  raised to 30 while under renovation to avoid false alarms during construction).
- It uses a **current occupancy flag** ("occupied" / "vacant"), **not** the actual dates the unit
  was occupied during the bill window.

So the renovation-then-move-in case above is currently **not handled** — the engine would just take
the full-period number against a flat ceiling. There is **no averaging and no area-under-the-curve**
today. This document proposes how to add that, and recommends *which* method to add and *when*.

---

## 3. The "grace period" rule (agreed on the call)

Before any math, one rule Jack explicitly approved: **a 2–3 day mismatch is ignored.** If the BGE
account flips names within a couple of days of the move date, or the water stub is a couple of days
off, we **do not** try to reconcile it. Chasing every penny isn't worth it, and "skipping" (a tenant
who just leaves) is rare.

**Design:** a single configurable knob — call it **grace days (default 2–3)**. If the gap between the
move date and the bill boundary is within grace, attribute the whole stub to the obvious party and
move on. This keeps 9 out of 10 cases trivial and reserves the real math for genuinely split bills.

---

## 4. The three methods we discussed (and how they compare)

There are three candidate ways to split a water bill across the move date. All three were raised on
the call.

### Method A — Daily average (Yaseen's suggestion: simplest)

Take the bill's **total usage ÷ number of days in the period**, then multiply by the number of days
the tenant was actually in.

- **May bill = 30 units over 31 days → ~0.97 units/day.** Tenant in for 17 days (May 15–31) →
  **~16.5 units charged to tenant**, the rest to Dominion.
- **Pros:** dead simple, works with **only the total** on the bill (no fancy data needed). Always
  available.
- **Cons:** assumes usage is **flat across the month**, which it isn't. In the renovation case it
  would *still* hand the tenant a slice of construction water (just a smaller, averaged slice). If a
  tenant throws a party on the last day, the average **under**-charges them.

### Method B — Days-based linear (Aditya's variant)

Same family as A, but instead of averaging the *whole* month, only count **units used from the
move-in date onward** if the data lets us isolate them, divided over the occupied days. In practice
this collapses into Method A unless we have sub-period (daily/weekly) data — in which case it becomes
Method C.

### Method C — Area under the curve — ❌ RULED OUT (June 19)

> **Not built and will not be built.** On the June 19 call Jack confirmed the bills
> are "just a meter reading date … probably monthly … no more granular consumption
> than bill date." With a single period total there is no curve to integrate, so
> Method C is impossible and the system ships Method A. The description is retained
> only to explain why it was rejected.

If the bill/portal exposes **consumption by day (or by week)**, we don't guess the shape — we
**read** it. We literally measure how much of the total usage fell **before** vs. **after** the move
date and split proportionally.

- Jack's framing: *"32% of the area under the curve is before the move-in date, 68% after — apportion
  accordingly."*
- In the renovation example, the construction spike (May 1–14) sits in the "before" bucket, so the
  tenant is correctly charged **only** for their actual May 15–31 usage. **This is the version that
  solves the overcharge problem.**
- **Pros:** matches reality; handles renovation front-loading and end-of-month spikes correctly;
  defensible to a tenant who disputes the bill.
- **Cons:** only possible **if the daily/interval data actually exists** on the Baltimore water /
  BGE bills. If the bill only shows a single total, Method C is impossible and we fall back to A.

### Side-by-side

| | Method A — Daily average | Method C — Area under the curve |
|---|---|---|
| Data needed | Just the period total | Daily or weekly consumption breakdown |
| Accuracy | Approximate (assumes flat usage) | Accurate (uses real usage shape) |
| Renovation overcharge | Still mis-charges (smaller) | **Solved** |
| Build effort | Low | Higher |
| Always usable? | Yes | Only if the data has the detail |

---

## 5. Recommended approach — adaptive, data-driven, with a human safety net

We do **not** have to pick one method forever. The recommendation is a **tiered/adaptive** rule that
picks the best method it can given the data, and always lets a human override:

1. **Grace check first.** If the move date is within the grace window (≈2–3 days) of the bill
   boundary → attribute the stub to the obvious party, no proration. (Handles most cases instantly.)
2. **BGE path.** If the BGE account changed names on/near the move date → **no reconciliation**, the
   tenant owns their portion by definition. Only surface an exception if the name-change is missing
   or far off the move date.
3. **Water path — pick the best available method:**
   - **If daily/weekly consumption data exists → Method C (area under the curve).**
   - **If only a period total exists → Method A (daily average).**
   - **If the property was under renovation during part of the window → exclude the renovation-window
     usage from the tenant's share** before computing their portion (so construction water never
     lands on the tenant).
4. **Round in the tenant's favor, lightly.** Jack is comfortable eating a few dollars; Aditya wants
   to avoid systematically over-charging. A small bias toward the tenant on rounding keeps disputes
   down at negligible cost.
5. **Human override always wins.** The computed split is a **suggestion**. The ops team sees the
   number, and if "$19 doesn't look right," they can type in "$23" and either bill back or refund.
   The system records both the computed and the final number.
6. **Surface as an exception when it's material.** Tiny splits auto-resolve; anything above a
   configurable dollar/threshold gets flagged for review before it's billed back.

This gives Jack the accuracy he wants *where the data supports it*, a safe fallback where it doesn't,
and a manual escape hatch everywhere.

---

## 6. The investigation that gated the build — RESOLVED (June 19)

> **Resolved on the call.** (a) Bill granularity: **single monthly meter read only** —
> no daily/weekly data — so Method C is off the table. (b) Variance test: moot, because
> with no sub-period data Method A is the only option regardless of variance. Decision:
> **ship Method A.** The original framing is kept below for the record.

Both Jack and Yaseen agreed: **don't build the fancy version until we know it's worth it.** Two
unknowns decide everything:

**(a) Does the data even support Method C?**
We need to **physically look at a real Baltimore water bill and a BGE bill** and confirm whether
consumption is shown **by day / by week**, or **only as a single period total.** Abdul's Postgres
updates **daily** and is sourced from Podio + AppFolio — but that's the *account/occupancy* data; we
still need to confirm the **consumption granularity** on the actual bills. *If there's no daily
breakdown, Method C is off the table and we ship Method A.*

**(b) Is the difference big enough to matter? (Yaseen's variance test)**
Pull a **sample of past bills with mid-month move-ins** from earlier billing cycles. For each, compute
**Method A (average)** and compare it to what the tenant **actually** should have paid. Measure the
**variance**:
- If the gap is consistently tiny (Jack: *"dude, it's $9, who cares"*) → **ship Method A**, done.
- If the gap is meaningful once multiplied across ~933 properties and repeated cycles → **build
  Method C**, the effort is justified.

**Recommendation:** treat this as a small, time-boxed data task **first**. The build decision falls
straight out of the numbers, and we avoid over-engineering something worth $9.

---

## 7. Reconciliation — where the money actually goes

Once the tenant's share is computed (or entered manually):

- **Water:** Dominion has already paid the full bill. The tenant's share is **billed back** — applied
  against the **security deposit** or invoiced — exactly as the human does it today, just calculated
  consistently.
- **BGE:** normally nothing to do (name change handles it). Only the rare few-day mismatch produces a
  small reconciliation, and grace usually absorbs it.
- **Sold/disposed properties:** unchanged from existing policy — water lingering bills are handled via
  the settlement statement (ignore), BGE lingering bills are an exception to call BGE about. Proration
  does not apply to a property we no longer own.

Every split is **logged** (computed value, final value, who changed it, why) so the trail is auditable
and shows up in the per-property decision summary the system already produces.

---

## 8. Implementation design — how to build it WITHOUT rewriting what exists

> This section is for the dev team. It describes wiring only; **it changes no code.** Names below
> refer to the current modules so the team can see exactly where each piece slots in.

### 8.1 What new information the engine needs (today it has none of this)

The routing input currently carries an **occupancy flag** and **consumption baselines**, but **no
dates and no usage shape**. Proration needs three new inputs threaded through from WS-1/WS-4:

- **Bill period:** `period_start` / `period_end` for each bill.
- **Occupancy timeline:** the tenant's **move-in / move-out dates** (and any renovation window) that
  overlap the bill period — so we can compute the split point.
- **Usage shape (optional but enables Method C):** daily or weekly consumption readings for the
  period. If absent, the engine knows to fall back to Method A.

### 8.2 Where each piece plugs in (new helpers, not rewrites)

- **A new pure-logic helper (e.g. `prorationEngine`)** sits **next to** the existing routing logic.
  It takes (bill period, occupancy timeline, optional daily readings, config) and returns
  `{ tenant_share, dominion_share, method_used, confidence, needs_review }`. Pure function, fully
  unit-testable, mirrors how the current decision logic is structured.
- **The consumption-anomaly step stays as-is.** Proration is a **separate concern** from the
  high-usage letter/work-order logic — it answers "who pays," not "is this a leak." They run
  independently on the same property.
- **WS-4 (water agent)** provides the bill period + readings it scrapes; **WS-5 (reconciliation
  layer)** is where the bill-back amount is recorded and surfaced. The proration result feeds the
  WS-7 report and the bill-back, gated behind Jack's approval like every other payment.

### 8.3 New config knobs (consistent with the existing env-override pattern)

The engine already reads thresholds from environment variables (vacant ceilings, multipliers, etc.).
Proration adds a few in the same style — **no structural change, just new keys:**

- `grace_days` — the 2–3 day ignore window (§3).
- `proration_method` — `auto` (default), `average`, or `area` — `auto` picks C when data allows, else A.
- `renovation_excludes_tenant` — on/off, whether renovation-window usage is stripped from the tenant share.
- `review_threshold_dollars` — splits above this surface as an exception for human review.

### 8.4 Decision flow (text, no code)

```
For each bill on each property:
  1. Is the move date within grace_days of the bill boundary?  → attribute whole stub, STOP.
  2. Is this BGE and did the account change names on/near the move date?  → no reconciliation, STOP.
  3. Otherwise (water, or a real split):
       a. Do we have daily/weekly readings?  → Method C (area under curve).
          else                               → Method A (daily average).
       b. Was any of the window under renovation AND renovation_excludes_tenant on?
          → remove renovation-window usage from the tenant's share.
       c. Compute tenant_share / dominion_share.
       d. Is tenant_share above review_threshold_dollars?  → flag for human review.
       e. Record computed value; allow manual override; log both.
```

### 8.5 Edge cases to cover in tests

- Move-in **and** move-out in the **same** bill period (tenant occupies a middle slice).
- Renovation that **ends** mid-period, immediately followed by move-in.
- Bill with **only a total** (forces Method A) vs. bill **with** daily data (allows Method C).
- Move date exactly **on** the grace boundary.
- Sold/disposed property — proration must **not** run.
- Manual override replacing the computed number (both values persisted).

---

## 9. Open questions — RESOLVED June 19 (one remains)

1. ~~**Bill granularity**~~ → **single monthly meter read only.** Method C off the table.
2. ~~**Variance result**~~ → moot (no sub-period data); **ship Method A.**
3. ~~**Grace window**~~ → **3 days, inclusive.**
4. ~~**Bill-back mechanism**~~ → **invoice** (security deposit is last-resort, not modeled).
5. ~~**Review threshold**~~ → **$10** (env-overridable).

**Still open — for Abdul (does not block the pure logic):**
- **Move-in/out date sourcing.** `prorationEngine` is built and unit-tested; WS-4 supplies the bill
  period. The remaining wiring is reading the tenant **move-in / move-out** (and renovation) dates
  from Abdul's Postgres — column names to confirm. Until then `occupancy_timeline` is null and
  proration no-ops (the routing/retrieval path is unaffected).

---

## 10. Bottom line for Jack

- For **BGE**, there's almost nothing to fix — the name-change on the move date already settles it,
  and a 2–3 day grace covers the rest.
- For **water**, we always pay and bill back, so we need a consistent split. We'll **start by checking
  whether the bills even show day-by-day usage** and **measure how far off a simple average is.**
- If simple averaging is close enough, we ship that. If it's worth it, we build the **area-under-the-
  curve** version that correctly keeps construction/renovation water off the tenant's bill.
- Either way, the number is a **suggestion the team can override**, every split is **logged**, and **no
  payment or bill-back happens without your approval.**

*Nothing above has been built or changed in the codebase yet — this is the plan for how we'd do it.*
