import { NextFunction, Request, Response } from 'express';
import {
  DataScopeError,
  Filters,
  SalespersonLockError,
  UserContext,
  applyRoleDataScope,
  applySalespersonLock,
} from '../measures/filters';
import { getRoleDataScopeRules } from '../services/dataScopeService';

/**
 * Application-level scope enforcement, replacing the previous Postgres-native Row-Level-Security
 * approach (the old rlsContext.ts, which used SET LOCAL/current_setting() against Postgres RLS
 * policies -- see the now-deprecated data/warehouse/migrations/0007_rls_policies.sql). MySQL has
 * no equivalent native RLS mechanism, so Standards Section 5.2's requirement ("Permissions are
 * enforced ... at the data layer (not just hidden UI elements), so a restricted user cannot see
 * another scope's data even via export or API") is met here instead: every route that queries
 * measures data MUST go through `resolveScopedFilters`, which is the ONLY place raw query-string
 * filters are converted into the `Filters` object passed to src/measures/tachometer.ts's query
 * functions. There is no code path in this codebase that builds a measures SQL query from
 * unvalidated request input directly.
 *
 * This is enforced per-request in application code (not hidden only in the UI), and for a
 * SALESPERSON-tier user it raises an explicit 403 (via SalespersonLockError) rather than silently
 * redirecting or silently substituting the caller's own scope, exactly per the port's
 * requirement -- see filters.ts's applySalespersonLock for the actual enforcement logic (ported
 * 1:1 from the validated Python filters.py, same 5 RBAC test cases).
 *
 * The same choke point also applies each user's business role's row-level data scope (the
 * role_data_scope table, admin-editable on the Role & Permission Management page) via
 * filters.ts's applyRoleDataScope -- a generalized version of the salesperson lock that can
 * restrict any of the 5 filter dimensions to an admin-assigned set of values, same "force if
 * unrequested, reject if requested-but-disallowed" contract, same 403-not-silent-substitution
 * behavior on a scope-escape attempt.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userContext?: UserContext;
      scopedFilters?: Filters;
    }
  }
}

/**
 * Builds the UserContext from the already-verified, DB-loaded request user (req.user, set by
 * requireAuth) and attaches it to the request. Must run after requireAuth.
 *
 * req.user.roleTierCode/salespersonKey come from the real app_user row (business role's default
 * scope tier, and the user's own salesperson_key column) rather than raw JWT claims -- see
 * backend/src/middleware/auth.ts and the 0009_auth_identity.sql migration. A SALESPERSON-tier
 * user with no salesperson_key assigned resolves to `null`, which applySalespersonLock below
 * still locks correctly (locked to nothing rather than accidentally unscoped).
 *
 * Also loads the user's business role's row-level data-scope rules (role_data_scope, see
 * dataScopeService.ts) here rather than in resolveScopedFilters, specifically so
 * resolveScopedFilters itself can stay synchronous (its own test suite calls it without awaiting
 * and asserts req.scopedFilters synchronously). Async here, not wrapped in try/catch, matching the
 * existing style of requireAuth/requirePermission's own DB calls.
 */
export async function attachUserContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  if (!req.user.roleTierCode) {
    res.status(403).json({ error: 'Your account has no data-scope role assigned. Contact your administrator.' });
    return;
  }

  const dataScopeRules = await getRoleDataScopeRules(req.user.roleId);

  req.userContext = {
    roleCode: req.user.roleTierCode,
    roleId: req.user.roleId,
    salespersonKey: req.user.salespersonKey,
    dataScopeRules,
  };
  next();
}

/**
 * Parses filter query params into a Filters object, then applies the Salesperson lock. Must run
 * after attachUserContext. On a scope-escape attempt (SalespersonLockError), responds 403 with a
 * clean message -- never the raw error/stack (Standards Section 5.9).
 */
/** Normalizes a query param that may arrive as absent, a single value, or (repeated-key) an array. */
function parseNumberArray(raw: unknown): number[] {
  if (raw === undefined) {
    return [];
  }
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((v) => Number(v)).filter((v) => !Number.isNaN(v));
}

function parseStringArray(raw: unknown): string[] {
  if (raw === undefined) {
    return [];
  }
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((v) => String(v));
}

export function resolveScopedFilters(req: Request, res: Response, next: NextFunction): void {
  if (!req.userContext) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  const q = req.query;
  const rawFilters: Filters = {
    companyKeys: parseNumberArray(q.companyKeys),
    segmentKeys: parseNumberArray(q.segmentKeys),
    channelKeys: parseNumberArray(q.channelKeys),
    salesTeamKeys: parseStringArray(q.salesTeamKeys),
    salespersonKeys: parseNumberArray(q.salespersonKeys),
  };

  try {
    const roleScoped = applyRoleDataScope(rawFilters, req.userContext.dataScopeRules ?? []);
    req.scopedFilters = applySalespersonLock(roleScoped, req.userContext);
  } catch (err) {
    if (err instanceof SalespersonLockError || err instanceof DataScopeError) {
      res.status(403).json({ error: 'Forbidden: request is outside your assigned scope.' });
      return;
    }
    next(err);
    return;
  }
  next();
}
