/**
 * WS-2 — Decision-trail summary + WS-7 letter / work-order builders (pure, no I/O).
 *
 * Split out of routingEngine.ts to keep that module focused and under the 500-line
 * limit. Everything here is a pure function over already-computed routing results.
 *
 *  - buildDecisionSummary(): the shorthand "why" shown for EVERY property in the
 *    WS-7 report (June 12 — Jack wants transparency for trust/adoption, not just
 *    on exceptions).
 *  - buildLettersAndWorkOrders(): turns consumption anomalies into the WS-7
 *    deliverables — a tenant letter for 1.5–3× usage, a letter + a maintenance
 *    work order above 3×. Per June 12, a letter goes out even when the tenant is
 *    responsible AND when Dominion pays the water (water_billable === false);
 *    only the verbiage differs (landlord vs tenant). Letters are never suppressed.
 *
 * Types DecisionStep / TenantLetter / WorkOrderRequest are owned by routingEngine.ts
 * and imported here as types only (no runtime cycle). These are artifacts only — no
 * letter is sent and no payment is made here.
 */
import type {
  PropertyRoutingResult, TenantLetter, WorkOrderRequest, ConsumptionAnomaly,
} from './routingEngine';
import type { PropertyRoutingInput, ConsumptionBaseline } from './propertySources';

/** Water cost-recovery verbiage: landlord-paid water (water_billable === false)
 *  gets "we pay, here are some tips"; otherwise the tenant pays and is reminded.
 *  Either way a letter is produced — only the wording changes (June 12). */
function letterResponsibility(p: PropertyRoutingInput, utility_type: string): 'landlord' | 'tenant' {
  if (utility_type === 'water' && p.water_billable === false) return 'landlord';
  return 'tenant';
}

export function buildLettersAndWorkOrders(
  p: PropertyRoutingInput,
  anomalies: ConsumptionAnomaly[]
): { letters: TenantLetter[]; work_orders: WorkOrderRequest[] } {
  const letters: TenantLetter[] = [];
  const work_orders: WorkOrderRequest[] = [];

  for (const a of anomalies) {
    if (a.contract_tier === 'NORMAL') continue;
    const responsibility = letterResponsibility(p, a.utility_type);
    const verb = responsibility === 'landlord'
      ? 'We cover this utility, but usage is high — sharing best practices to bring it down.'
      : 'This bill is your responsibility and is running high — please review usage.';
    letters.push({
      property_id: a.property_id, property_name: a.property_name, unit_id: a.unit_id,
      utility_type: a.utility_type, tier: a.contract_tier, responsibility,
      reading: a.reading, expected: a.baseline,
      summary: `[${responsibility}] ${a.property_name} unit ${a.unit_id}: ${a.reading} units (expected ~${a.baseline ?? '?'}). ${verb}`,
    });
    if (a.contract_tier === 'LETTER_PLUS_WORKORDER') {
      work_orders.push({
        property_id: a.property_id, property_name: a.property_name, unit_id: a.unit_id,
        utility_type: a.utility_type, reading: a.reading, expected: a.baseline,
        reason: `Consumption ${a.reading} ≥ 3× expected (${a.baseline ?? '?'}) — physically inspect for leak / unauthorized use.`,
      });
    }
  }
  return { letters, work_orders };
}

/** Effective quarterly baseline for a unit: prefer the occupancy-derived
 *  computed_quarterly_baseline (adults×10 + children×5) when WS-1 has wired it,
 *  otherwise the stored Podio baseline_amount. */
export function computeBaseline(
  b: Pick<ConsumptionBaseline, 'baseline_amount' | 'computed_quarterly_baseline'>
): number | null {
  if (b.computed_quarterly_baseline != null && b.computed_quarterly_baseline > 0) {
    return b.computed_quarterly_baseline;
  }
  return b.baseline_amount != null && b.baseline_amount > 0 ? b.baseline_amount : null;
}

/** A compact, ordered, plain-English shorthand of the property's verdicts — the
 *  "audit trail" Jack asked to see on every property, exceptions or not. */
export function buildDecisionSummary(
  result: PropertyRoutingResult,
  _p: PropertyRoutingInput
): string {
  const lines: string[] = [`Property: ${result.property_name} → ${result.buckets.join(', ')}`];

  for (const d of result.decisions) {
    const last = d.trail[d.trail.length - 1];
    const why = last ? `${last.evaluated} → ${last.outcome}` : d.reason_code;
    lines.push(`  ${d.utility.toUpperCase()}: ${d.decision} (${d.reason_code}) — ${why}`);
  }

  if (result.anomalies.length) {
    const tiers = result.anomalies.map(a => a.contract_tier).join(', ');
    lines.push(`  Consumption: ${result.anomalies.length} flagged (${tiers}); ` +
      `${result.letters.length} letter(s), ${result.work_orders.length} work order(s).`);
  } else {
    lines.push('  Consumption: normal.');
  }

  if (result.occupancy_check_required) {
    lines.push('  ⚠ BGE reverted to landlord on an occupied unit — occupancy check required (manual).');
  }
  return lines.join('\n');
}
