/**
 * WS-6 — audit-log middleware (public surface).
 *
 * The reusable, source-agnostic audit writer and the WS-6 feedback hook. The
 * implementation lives in db.ts alongside the connection pool and the
 * offline-JSONL fallback (a single source for the `dbOffline` flag, and no
 * circular import); this module is the named entry point WS-6 code imports.
 *
 *   import { logAuditEvent, recordRoutingFeedback } from './helpers/auditLog';
 */
export {
  logAuditEvent,
  logBGERun,
  logWaterRun,
  recordRoutingFeedback,
} from './db';

export type { AuditEvent, AuditEntity, AuditSource } from './db';
