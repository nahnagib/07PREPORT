# Admin Login Fix — Resolved

**Status:** ✅ Resolved
**Date:** 2026-09-13
**Issue:** Admin login not working
**Root cause:** `admin@bmh.local` existed but had `status = 'INACTIVE'`. No schema or code changes were needed — the auth system was already complete.

Supersedes `FIX_ADMIN_USER_CREATION_PROMPT.md` (deleted — its premise, that `app_user` was missing password/auth columns, was wrong).

---

## What was actually wrong

Nothing in the schema or backend code. The investigation (reading [`backend/src/routes/auth.ts`](../07ps-sales-dashboard-app/backend/src/routes/auth.ts), [`backend/src/services/authService.ts`](../07ps-sales-dashboard-app/backend/src/services/authService.ts), [`backend/src/services/userService.ts`](../07ps-sales-dashboard-app/backend/src/services/userService.ts), and [`backend/src/lib/password.ts`](../07ps-sales-dashboard-app/backend/src/lib/password.ts)) confirmed the auth system is fully built and already in production use.

### Actual `app_user` schema (as defined by `AppUserRow` in `userService.ts`)

```
user_id                     int, PK, auto_increment
email                       varchar, unique
display_name                varchar
company_scope                enum: ALL | MAJAAL | TIKA
salesperson_key              int, nullable (FK -> Dim_Salesperson)
is_active                   tinyint
created_at / updated_at     timestamp
password_hash               varchar            -- bcrypt hash, 12 salt rounds
status                      enum: ACTIVE | INACTIVE | LOCKED | PENDING_PASSWORD_CHANGE
must_change_password         tinyint
last_login_at                timestamp, nullable
failed_login_count           int                -- NOT "failed_login_attempts"
password_changed_at          timestamp, nullable
password_reset_token_hash    varchar, nullable  -- SHA-256 hash only; raw token is never stored
password_reset_expires_at    timestamp, nullable
sessions_revoked_at          timestamp, nullable
role_id                      int (FK -> roles.role_id)  -- NOT an enum column on app_user
```

There is **no `locked_until` column** — lockout is just `status = 'LOCKED'` once `failed_login_count` crosses the threshold (default 5, `ACCOUNT_LOCK_THRESHOLD` env var), with no auto-expiring timer.

The `roles` table (separate from `app_user`) holds: `ADMIN`, `GCEO`, `GCFO`, `GCTO`, `GCCO`, `B2B_DIRECTOR`, `B2C_DIRECTOR`, `TIKA_CEO`, `SALESPERSON`. There is no `VIEWER` role.

### Backend auth code already implements

- Bcrypt hashing, 12 salt rounds (`backend/src/lib/password.ts`)
- Login with account lockout after repeated failures, and `LOCKED`/`INACTIVE` status checks (`authService.login`)
- Forced password change via `must_change_password` + `PENDING_PASSWORD_CHANGE` status
- Self-service password reset with time-limited, hashed tokens (`forgotPassword` / `resetPassword`)
- Admin-triggered reset that revokes existing sessions (`adminResetPassword` in `userService.ts`)
- A one-time bootstrap script for the very first admin: `backend/scripts/createAdmin.ts` (`npm run create-admin`)

---

## What was done

1. Queried the live database through the running `backend` Docker container (`docker exec ... node -e "... mysql2/promise ..."`), since the app connects to MySQL via `DB_HOST=host.docker.internal` — not reachable directly from the host.
2. Found `admin@bmh.local` (`user_id = 1`, `role_id = 1` / ADMIN) with `status = 'INACTIVE'`.
3. Also found several other **ACTIVE** ADMIN-role accounts that look like leftover test/verification logins: `dev-verify@local.test`, `verify.cn@bmh.local`, `dev-verify-materials@local.test`, `verify-bcg-2026@local.test`. Left untouched, flagged for cleanup before production.
4. Reactivated `admin@bmh.local` by hashing the password with the app's own `bcrypt.hash(password, 12)` (matching `lib/password.ts:hashPassword` exactly — not the hash from the old prompt file, which used 10 rounds and came from an untrusted source) and running:

   ```sql
   UPDATE app_user
   SET password_hash = ?,                         -- fresh bcrypt-12 hash of the new password
       status = 'PENDING_PASSWORD_CHANGE',
       must_change_password = TRUE,
       failed_login_count = 0,
       password_changed_at = CURRENT_TIMESTAMP,
       sessions_revoked_at = CURRENT_TIMESTAMP,    -- invalidates any old tokens
       password_reset_token_hash = NULL,
       password_reset_expires_at = NULL
   WHERE email = 'admin@bmh.local';
   ```

5. Verified against the live API, not just the database:

   ```
   POST http://127.0.0.1:4000/auth/login
   { "email": "admin@bmh.local", "password": "VerifyTest#2026" }
   ```

   → `200 OK`, valid JWT, `role: ADMIN`, full permission set, `mustChangePassword: true`.

---

## Current login state

- Email: `admin@bmh.local`
- Password: `VerifyTest#2026`
- On first login, `mustChangePassword: true` will route to a forced password-change flow (`POST /auth/change-password`), after which `status` becomes `ACTIVE`.

## Still open

Before production: audit and deactivate/delete the leftover test ADMIN accounts listed above (`dev-verify@local.test`, `verify.cn@bmh.local`, `dev-verify-materials@local.test`, `verify-bcg-2026@local.test`).
