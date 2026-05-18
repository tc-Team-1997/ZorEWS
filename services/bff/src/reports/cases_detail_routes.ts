// services/bff/src/reports/cases_detail_routes.ts
//
// Express router for the row-level Cases Report (BAC §3.1.8) +
// per-user saved filters. Mounted via server.ts when the deps are
// provided.

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router as RouterType,
} from 'express';
import type { Pool } from 'pg';

import { extractCtx, wrapError, wrapResponse } from '../envelope';
import {
  exportCsv,
  exportPdf,
  exportXlsx,
  ROW_CAP,
} from './cases_detail_exporters';
import {
  isValidSortColumn,
  type AgeBucket,
  type CaseRow,
  type CasesDetailFilter,
  type CasesDetailReport,
  type CasesDetailSource,
  type ExportFormat,
  type Severity,
} from './cases_detail_query';
import {
  SavedFilterError,
  validateCreate,
  validateUpdate,
  type ReportType,
  type SavedFilterStore,
} from './saved_filters_store';

export interface CasesDetailRouterDeps {
  /** Source for the report data — Pg in prod, in-memory adapter in tests. */
  source: CasesDetailSource;
  savedFilterStore: SavedFilterStore;
  /** Optional: when present, every export writes one row here. */
  auditPool?: Pool | null;
  /** Optional: when present, DELETE /v1/reports/cases/filters/:id
   *  archives the row into app_recovery.deleted_records first via
   *  this store. When undefined, hard-delete (legacy behaviour) —
   *  kept for tests that don't wire the Recovery Center.
   *  `get` (post-archive lookup for audit fan-out) is optional —
   *  skipping it just suppresses the audit event. */
  recoveryStore?: {
    archive: (input: {
      tenant_id: string;
      module: 'bff';
      entity_type: string;
      original_id: string;
      original_table: string;
      payload: Record<string, unknown>;
      deleted_by: string;
      source_action?: string | null;
    }) => Promise<string>;
    get?: (
      tenant_id: string,
      recovery_id: string,
    ) => Promise<
      | {
          recovery_id: string;
          tenant_id: string;
          module: string;
          entity_type: string;
          original_id: string;
          original_table: string;
          deleted_by: string;
          deleted_at: string;
          restored_at: string | null;
          restored_by: string | null;
          purged_at: string | null;
          purged_by: string | null;
          status: 'archived' | 'restored' | 'purged';
        }
      | undefined
    >;
  };
  /** Optional: audit-fan-out for recovery lifecycle events. Typed
   *  via the real AuditTrailStore — keeps the sub-router and the
   *  central audit_trail module in lockstep on enum values. */
  auditTrailStore?: import('../audit_trail').AuditTrailStore;
  /** Caller role accessor — for tagging the audit event. */
  getRole?: (req: import('express').Request) => string | null;
  requireTenantMw: RequestHandler;
  requireRole: (op: string) => RequestHandler;
  now?: () => Date;
}

// Tested values must round-trip through URL params.
const VALID_AGE_BUCKETS: ReadonlyArray<AgeBucket> = ['0-7d', '8-30d', '31-90d', '90+d', 'ALL'];
const VALID_SEVERITY: ReadonlyArray<Severity> = ['high', 'medium', 'low'];
const VALID_FORMATS: ReadonlyArray<ExportFormat> = ['json', 'csv', 'xlsx', 'pdf'];

export function makeCasesDetailRouter(deps: CasesDetailRouterDeps): RouterType {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  const handleErr = (err: unknown, req: Request, res: Response): void => {
    const ctx = extractCtx(req, now);
    if (err instanceof SavedFilterError) {
      res.status(err.status).json(
        wrapError(
          { code: err.code, message: err.message, severity: err.status >= 500 ? 'HIGH' : 'MEDIUM' },
          ctx,
        ),
      );
      return;
    }
    res.status(500).json(
      wrapError(
        { code: 'EWS_500', message: err instanceof Error ? err.message : 'internal error', severity: 'HIGH' },
        ctx,
      ),
    );
  };
  const wrap =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
      void fn(req, res, next).catch((e) => handleErr(e, req, res));
    };

  // ── Audit fan-out ─────────────────────────────────────────────────

  const writeExportAudit = async (params: {
    tenant_id: string;
    actor_id: string;
    actor_role: string;
    format: Exclude<ExportFormat, 'json'>;
    rows: number;
    bytes: number;
    duration_ms: number;
    filters: CasesDetailFilter;
    request_id?: string;
    ip?: string;
    user_agent?: string;
  }) => {
    if (!deps.auditPool) return;
    try {
      await deps.auditPool.query(
        `INSERT INTO app_admin.admin_audit_log
           (tenant_id, entity_type, entity_id, action, actor_id, actor_role,
            after_state, request_id, ip_address, user_agent)
         VALUES ($1, 'report_export', 'cases:detail', 'export', $2, $3, $4::jsonb, $5, $6::inet, $7)`,
        [
          params.tenant_id,
          params.actor_id,
          params.actor_role,
          JSON.stringify({
            format: params.format,
            rows: params.rows,
            bytes: params.bytes,
            duration_ms: params.duration_ms,
            filters: params.filters,
          }),
          params.request_id ?? null,
          params.ip ?? null,
          params.user_agent ?? null,
        ],
      );
    } catch {
      // Audit failures must never block the response. The dispatcher
      // pattern in user_access_override does the same.
    }
  };

  // ── GET /v1/reports/cases/detail ───────────────────────────────────

  router.get(
    '/v1/reports/cases/detail',
    deps.requireTenantMw,
    deps.requireRole('reports:cases:view'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const q = req.query;

      // Format determines whether `reports:cases:export` is also required
      const fmtRaw = typeof q.format === 'string' ? q.format : 'json';
      if (!VALID_FORMATS.includes(fmtRaw as ExportFormat)) {
        return res.status(400).json(
          wrapError(
            {
              code: 'EWS_400_invalid_input',
              message: `format must be one of ${VALID_FORMATS.join(',')}`,
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }
      const format = fmtRaw as ExportFormat;

      // Export RBAC double-check (manual since the route allows view-only)
      if (format !== 'json') {
        const role =
          (req.headers['x-apex-role'] as string | undefined) ?? '';
        const exportRoles = ['admin', 'supervisor'];
        if (!exportRoles.includes(role)) {
          return res.status(403).json(
            wrapError(
              {
                code: 'EWS_403_export_denied',
                message: `role ${role || '(none)'} can view but not export — needs reports:cases:export`,
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
      }

      // Filter parsing + validation
      const filter: CasesDetailFilter = {};
      if (typeof q.ageBucket === 'string') {
        if (!VALID_AGE_BUCKETS.includes(q.ageBucket as AgeBucket)) {
          return res.status(400).json(
            wrapError(
              {
                code: 'EWS_400_invalid_input',
                message: `ageBucket must be one of ${VALID_AGE_BUCKETS.join(',')}`,
                severity: 'MEDIUM',
              },
              ctx,
            ),
          );
        }
        if (q.ageBucket !== 'ALL') filter.ageBucket = q.ageBucket as Exclude<AgeBucket, 'ALL'>;
      }
      if (typeof q.breached === 'string') filter.breached = q.breached === 'true';
      if (typeof q.from === 'string' && q.from) {
        if (Number.isNaN(Date.parse(q.from))) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'from must be ISO 8601', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filter.from = q.from;
      }
      if (typeof q.to === 'string' && q.to) {
        if (Number.isNaN(Date.parse(q.to))) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'to must be ISO 8601', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filter.to = q.to;
      }
      if (typeof q.branch === 'string' && q.branch) filter.branch = q.branch;
      if (typeof q.status === 'string' && q.status) {
        filter.status = q.status.split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (typeof q.severity === 'string' && q.severity) {
        const arr = q.severity.split(',').map((s) => s.trim()).filter(Boolean);
        for (const s of arr) {
          if (!VALID_SEVERITY.includes(s as Severity)) {
            return res.status(400).json(
              wrapError(
                {
                  code: 'EWS_400_invalid_input',
                  message: `severity must be one of ${VALID_SEVERITY.join(',')}`,
                  severity: 'MEDIUM',
                },
                ctx,
              ),
            );
          }
        }
        filter.severity = arr as Severity[];
      }
      if (typeof q.q === 'string' && q.q) filter.q = q.q;
      if (typeof q.sort === 'string') {
        if (!isValidSortColumn(q.sort)) {
          return res.status(400).json(
            wrapError(
              { code: 'EWS_400_invalid_input', message: 'invalid sort column', severity: 'MEDIUM' },
              ctx,
            ),
          );
        }
        filter.sort = q.sort;
      }
      if (q.dir === 'asc' || q.dir === 'desc') filter.dir = q.dir;
      if (typeof q.page === 'string') filter.page = Number(q.page);
      if (typeof q.page_size === 'string') filter.page_size = Number(q.page_size);

      // For exports, we want the FULL filtered result set (not a single
      // page). The query path always returns paginated rows; we cap the
      // page_size at ROW_CAP[format] for non-json formats.
      const isExport = format !== 'json';
      if (isExport) {
        filter.page = 1;
        filter.page_size = ROW_CAP[format as keyof typeof ROW_CAP];
      }

      const t0 = Date.now();
      const report: CasesDetailReport = await deps.source.run(
        req.tenant!.tenant_id,
        filter,
        now(),
      );
      const duration_ms = Date.now() - t0;

      if (format === 'json') {
        res.json(wrapResponse(report, ctx));
        return;
      }

      // Export path — over-cap protection
      if (report.total > ROW_CAP[format as keyof typeof ROW_CAP]) {
        return res.status(413).json(
          wrapError(
            {
              code: 'EWS_413_too_many_rows',
              message: `${report.total} rows exceeds the ${format} cap of ${ROW_CAP[format as keyof typeof ROW_CAP]}. Narrow the filter or use CSV/Excel.`,
              severity: 'MEDIUM',
            },
            ctx,
          ),
        );
      }

      const meta = {
        tenant_id: req.tenant!.tenant_id,
        generated_at: report.generated_at,
        generated_by:
          (req.headers['x-apex-user'] as string | undefined) ??
          (req.headers['x-apex-role'] as string | undefined) ??
          'unknown',
        filters: filter,
      };
      const stamp = new Date(report.generated_at).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filenameBase = `cases-report-${req.tenant!.tenant_id}-${stamp}`;

      let body: Buffer | string;
      let contentType: string;
      let filename: string;
      if (format === 'csv') {
        body = exportCsv(report.items, meta);
        contentType = 'text/csv; charset=utf-8';
        filename = `${filenameBase}.csv`;
      } else if (format === 'xlsx') {
        body = await exportXlsx(report.items, meta);
        contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        filename = `${filenameBase}.xlsx`;
      } else {
        body = await exportPdf(report.items, meta);
        contentType = 'application/pdf';
        filename = `${filenameBase}.pdf`;
      }
      const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.length;

      // Audit: fire-and-forget
      const totalDuration = Date.now() - t0;
      void writeExportAudit({
        tenant_id: req.tenant!.tenant_id,
        actor_id: meta.generated_by,
        actor_role: (req.headers['x-apex-role'] as string | undefined) ?? 'admin',
        format: format as Exclude<ExportFormat, 'json'>,
        rows: report.items.length,
        bytes,
        duration_ms: totalDuration,
        filters: filter,
        request_id: (req.headers['x-request-id'] as string | undefined) ?? undefined,
        ip:
          (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip,
        user_agent: req.headers['user-agent'] as string | undefined,
      });
      void duration_ms; // already folded into totalDuration

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Generated-At', report.generated_at);
      res.setHeader('X-Row-Count', String(report.items.length));
      res.send(body);
      void { caseRowSentinel: undefined as unknown as CaseRow };
    }),
  );

  // ── Saved filters CRUD ────────────────────────────────────────────

  const reportTypeFromPath = 'cases' as ReportType;
  const ownerOf = (req: Request) =>
    (req.headers['x-apex-user'] as string | undefined) ?? 'unknown';

  router.get(
    '/v1/reports/cases/filters',
    deps.requireTenantMw,
    deps.requireRole('reports:cases:view'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const items = await deps.savedFilterStore.list(
        req.tenant!.tenant_id,
        ownerOf(req),
        reportTypeFromPath,
      );
      res.json(wrapResponse({ items, total: items.length }, ctx));
    }),
  );

  router.post(
    '/v1/reports/cases/filters',
    deps.requireTenantMw,
    deps.requireRole('reports:cases:view'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      // Force report_type=cases for this path
      const body = (req.body ?? {}) as Record<string, unknown>;
      const validated = validateCreate({ ...body, report_type: 'cases' });
      const out = await deps.savedFilterStore.create(
        req.tenant!.tenant_id,
        ownerOf(req),
        validated,
        now(),
      );
      res.status(201).json(wrapResponse(out, ctx));
    }),
  );

  router.put(
    '/v1/reports/cases/filters/:id',
    deps.requireTenantMw,
    deps.requireRole('reports:cases:view'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const patch = validateUpdate(req.body ?? {});
      const out = await deps.savedFilterStore.update(
        req.tenant!.tenant_id,
        req.params.id,
        ownerOf(req),
        patch,
        now(),
      );
      res.json(wrapResponse(out, ctx));
    }),
  );

  router.delete(
    '/v1/reports/cases/filters/:id',
    deps.requireTenantMw,
    deps.requireRole('reports:cases:view'),
    wrap(async (req, res) => {
      const ctx = extractCtx(req, now);
      const tenant_id = req.tenant!.tenant_id;
      const filter_id = req.params.id;
      // Archive before delete so the row is recoverable via Recovery
      // Center. Archive failure is non-blocking — the store.delete
      // call below stays the source-of-truth for 404/403 outcomes.
      if (deps.recoveryStore) {
        try {
          const existing = await deps.savedFilterStore.get(tenant_id, filter_id);
          if (existing) {
            const actor =
              ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() ||
              ownerOf(req) ||
              'admin';
            const recovery_id = await deps.recoveryStore.archive({
              tenant_id,
              module: 'bff',
              entity_type: 'saved_report_filter',
              original_id: filter_id,
              original_table: 'app_admin.saved_report_filters',
              payload: existing as unknown as Record<string, unknown>,
              deleted_by: actor,
              source_action: 'user_initiated',
            });
            // Audit fan-out — fetch the freshly-archived row + emit.
            if (deps.recoveryStore.get && deps.auditTrailStore) {
              const archived = await deps.recoveryStore.get(tenant_id, recovery_id);
              if (archived) {
                try {
                  deps.auditTrailStore.record(
                    tenant_id,
                    {
                      actor_username: actor,
                      actor_role: (deps.getRole?.(req) ?? 'admin') as string,
                      action: 'recovery.archive',
                      resource_type: 'system',
                      resource_id: archived.recovery_id,
                      outcome: 'success',
                      severity: 'info',
                      metadata: {
                        entity_type: archived.entity_type,
                        original_id: archived.original_id,
                        original_table: archived.original_table,
                        module: archived.module,
                        deleted_by: archived.deleted_by,
                        deleted_at: archived.deleted_at,
                      },
                    },
                    now(),
                  );
                } catch (err) {
                  console.error('[recovery] audit fan-out failed', err);
                }
              }
            }
          }
        } catch (err) {
          console.error('[recovery] archive failed for saved_report_filter', filter_id, err);
        }
      }
      await deps.savedFilterStore.delete(
        tenant_id,
        filter_id,
        ownerOf(req),
      );
      res.json(wrapResponse({ deleted: true }, ctx));
    }),
  );

  return router;
}
