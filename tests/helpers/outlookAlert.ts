/**
 * WS-6 — Outlook alert channel (replaces the earlier Slack webhook).
 *
 * Posts a JSON payload to a Power Automate "When an HTTP request is received"
 * flow URL (OUTLOOK_WEBHOOK_URL). The flow delivers the alert into Outlook —
 * e.g. "Send an email (V2)" to the ops mailbox — using the fields below.
 *
 * Power Automate request-trigger schema to configure on the flow:
 *   { "subject": string, "severity": "info"|"warning"|"critical",
 *     "source": string, "run_id": string, "body": string }
 *
 * Alerts are best-effort and batched by the caller: one message per run, never
 * one per property. A missing OUTLOOK_WEBHOOK_URL logs and continues — alerting
 * must never take down the weekly run.
 */
import { ConsumptionAnomaly, RoutingRunResult } from './routingEngine';
import { RunSummary } from './runSummary';

export interface OutlookAlert {
  subject: string;
  severity: 'info' | 'warning' | 'critical';
  source: string;       // e.g. 'WS-2 routing'
  run_id: string;
  body: string;         // plain text; the flow renders it into the email body
}

export async function sendOutlookAlert(alert: OutlookAlert): Promise<boolean> {
  const url = process.env.OUTLOOK_WEBHOOK_URL;
  if (!url) {
    console.warn('[Alert] OUTLOOK_WEBHOOK_URL not set — alert logged only:\n' +
      `  [${alert.severity}] ${alert.subject}\n${indent(alert.body)}`);
    return false;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alert),
    });
    if (!res.ok) {
      console.warn(`[Alert] Outlook webhook returned ${res.status} ${res.statusText} — alert may not have been delivered.`);
      return false;
    }
    console.log(`[Alert] Outlook ping sent: ${alert.subject}`);
    return true;
  } catch (e: any) {
    console.warn(`[Alert] Outlook webhook POST failed (non-fatal): ${e?.message ?? e}`);
    return false;
  }
}

/** One batched consumption/exception alert for a WS-2 run. Returns null when
 *  there is nothing wrong — caller skips the ping entirely. */
export function buildWs2Alert(run: RoutingRunResult): OutlookAlert | null {
  const severe = allAnomalies(run).filter(a => a.tier === 'SEVERE');
  const moderate = allAnomalies(run).filter(a => a.tier === 'MODERATE');
  const exceptions = run.results.flatMap(r =>
    r.decisions.filter(d => d.decision === 'EXCEPTION').map(d => ({ r, d })));
  const occupancyChecks = run.results.filter(r => r.occupancy_check_required);

  if (severe.length === 0 && moderate.length === 0 && exceptions.length === 0 &&
      occupancyChecks.length === 0 && run.totals.work_orders === 0) return null;

  const lines: string[] = [];
  if (severe.length) {
    lines.push(`SEVERE consumption anomalies (${severe.length}):`);
    lines.push(...severe.slice(0, 25).map(fmtAnomaly), ...more(severe.length, 25));
  }
  if (moderate.length) {
    lines.push('', `Moderate consumption spikes (${moderate.length}):`);
    lines.push(...moderate.slice(0, 25).map(fmtAnomaly), ...more(moderate.length, 25));
  }
  if (occupancyChecks.length) {
    lines.push('', `Occupancy checks required — BGE reverted to landlord on an occupied unit (${occupancyChecks.length}):`);
    lines.push(...occupancyChecks.slice(0, 40).map(r => `  • ${r.property_name}`),
      ...more(occupancyChecks.length, 40));
  }
  if (exceptions.length) {
    lines.push('', `Routing exceptions for review (${exceptions.length}):`);
    lines.push(...exceptions.slice(0, 40).map(({ r, d }) =>
      `  • ${r.property_name} [${d.utility}] ${d.reason_code}: ${d.detail}`),
      ...more(exceptions.length, 40));
  }
  lines.push('', `WS-7 deliverables staged — ${run.totals.letters} tenant letter(s), ` +
    `${run.totals.work_orders} work order(s).`);
  lines.push('', `Totals — BGE-pay: ${run.totals.bge_pay}, Water-pay: ${run.totals.water_pay}, ` +
    `Tenant-skip: ${run.totals.tenant_skip}, Exceptions: ${run.totals.exception}.`);
  lines.push('', 'Disagree with any verdict? Use the "Leave feedback" link on the property ' +
    'in the WS-7 report (logged to routing_feedback for review).');

  return {
    subject: `Dominion WS-2 ${run.run_id}: ` +
      (severe.length ? `${severe.length} SEVERE anomalies, ` : '') +
      `${exceptions.length} exceptions` +
      (occupancyChecks.length ? `, ${occupancyChecks.length} occupancy checks` : ''),
    severity: severe.length ? 'critical' : 'warning',
    source: 'WS-2 routing',
    run_id: run.run_id,
    body: lines.join('\n'),
  };
}

/** WS-6 weekly digest — the "what we did this week" rollup, built from the
 *  run_summary row. Always returns an alert (the digest is sent every run, even
 *  a clean one). Severity escalates on failed payments / severe anomalies. */
export function buildRunDigest(s: RunSummary): OutlookAlert {
  const severity: OutlookAlert['severity'] =
    (s.severe_anomalies > 0 || s.payments_failed > 0) ? 'critical'
    : (s.exception_count > 0 || s.occupancy_checks > 0) ? 'warning'
    : 'info';

  const money = (n: number) => `$${n.toFixed(2)}`;
  const lines: string[] = [
    `Routing — BGE-pay: ${s.bge_pay}, Water-pay: ${s.water_pay}, ` +
      `Tenant-skip: ${s.tenant_skip}, Exceptions: ${s.exception_count}.`,
    `Accounts routed — BGE: ${s.bge_accounts_seen}, Water: ${s.water_accounts_seen}.`,
    '',
    `Payments — ${s.payments_confirmed} confirmed (${money(s.amount_paid_total)}), ` +
      `${s.payments_failed} failed, ${s.payments_skipped} skipped (no approval).`,
    '',
    `Consumption — ${s.severe_anomalies} severe, ${s.moderate_anomalies} moderate ` +
      `anomalies. WS-7 staged: ${s.letters} letter(s), ${s.work_orders} work order(s).`,
    `Proration — ${s.prorations_needing_review} split(s) need human review.`,
  ];
  if (s.occupancy_checks > 0) {
    lines.push('', `${s.occupancy_checks} occupancy check(s) required ` +
      `(BGE reverted to landlord on an occupied unit).`);
  }

  return {
    subject: `Dominion weekly summary ${s.run_id}: ` +
      `${s.payments_confirmed} paid (${money(s.amount_paid_total)}), ` +
      `${s.exception_count} exceptions, ${s.severe_anomalies} severe anomalies`,
    severity,
    source: 'WS-6 summary',
    run_id: s.run_id,
    body: lines.join('\n'),
  };
}

function allAnomalies(run: RoutingRunResult): ConsumptionAnomaly[] {
  return run.results.flatMap(r => r.anomalies);
}

function fmtAnomaly(a: ConsumptionAnomaly): string {
  return `  • ${a.property_name} unit ${a.unit_id} [${a.kind}] ${a.detail}`;
}

function more(total: number, shown: number): string[] {
  return total > shown ? [`  … and ${total - shown} more (see cache/ws2-latest.json)`] : [];
}

function indent(s: string): string {
  return s.split('\n').map(l => '  ' + l).join('\n');
}
