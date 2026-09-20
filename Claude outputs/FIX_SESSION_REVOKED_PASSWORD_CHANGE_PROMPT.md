# Fix: Session Revoked Error on Password Change

**Status:** BLOCKING — Admin cannot change password after reactivation  
**Issue:** "Session has been revoked. Please sign in again" when attempting PATCH /auth/change-password  
**Root Cause:** `sessions_revoked_at` timestamp check is rejecting valid JWTs  
**Priority:** High — prevents admin login flow completion  

---

## Problem Summary

After reactivating `admin@bmh.local`:
1. ✅ Login works: `POST /auth/login` returns valid JWT
2. ✅ Frontend redirects to password change screen (status=PENDING_PASSWORD_CHANGE)
3. ❌ Password change fails: `PATCH /auth/change-password` returns "Session has been revoked"

**Why this happens:**

During reactivation, `sessions_revoked_at = CURRENT_TIMESTAMP` was set to invalidate all old sessions. However, the JWT issued from the fresh login may have been created **before** the revocation timestamp, or the backend's session validation logic is checking `sessions_revoked_at` incorrectly.

**Example timing issue:**
```
12:00:00 — Admin account reactivated, sessions_revoked_at = 12:00:00
12:00:01 — POST /auth/login is called
12:00:02 — JWT is issued (iat = 12:00:02, should be valid)
12:00:03 — PATCH /auth/change-password is called with JWT
❌ Backend checks: if (jwt.iat < user.sessions_revoked_at) → reject
         12:00:02 < 12:00:00? NO... but error still occurs
```

This suggests either:
1. JWT was issued before revocation (timing race condition)
2. Backend revocation check is inverted/broken
3. `sessions_revoked_at` is NULL and caught by different logic

---

## Step 1: Investigate Backend Session Validation

### 1.1 Find the Session Check Code

**File:** `backend/src/middleware/auth.ts` or `backend/src/middleware/authenticateJWT.ts`

Look for the JWT validation middleware:

```typescript
// Pattern to find:
export const authenticateJWT = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // This is where sessions_revoked_at is checked:
    const user = await db.query('SELECT sessions_revoked_at FROM app_user WHERE user_id = ?', [decoded.userId]);
    
    // ❓ What check happens here?
    // if (user.sessions_revoked_at && decoded.iat < user.sessions_revoked_at) { ... }
    // OR
    // if (user.sessions_revoked_at) { REJECT EVERYTHING } ?
    
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Session has been revoked. Please sign in again.' });
  }
};
```

**Questions to answer:**
- How is `sessions_revoked_at` being checked?
- Is it comparing JWT `iat` (issued-at) timestamp with `sessions_revoked_at`?
- Or is it just checking if `sessions_revoked_at` is NOT NULL (rejecting all)?
- Is the check using the correct timezone/UTC conversion?

### 1.2 Find the Password Change Endpoint

**File:** `backend/src/routes/auth.ts` or `backend/src/routes/password.ts`

Look for PATCH /auth/change-password:

```typescript
router.patch('/auth/change-password', authenticateJWT, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id; // From JWT
  
  try {
    // 1. Fetch user with password_hash and must_change_password
    const user = await db.query(
      'SELECT password_hash, must_change_password FROM app_user WHERE user_id = ?',
      [userId]
    );
    
    // 2. Verify current password
    const passwordMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    // 3. Hash new password
    const newHash = await bcrypt.hash(newPassword, 12);
    
    // 4. Update user, clear must_change_password flag
    await db.query(
      'UPDATE app_user SET password_hash = ?, must_change_password = false WHERE user_id = ?',
      [newHash, userId]
    );
    
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

The endpoint looks fine. The issue is in the `authenticateJWT` middleware blocking the request before it reaches here.

---

## Step 2: Diagnose the Exact Issue

### 2.1 Check Backend Logs

Run this to see what's happening:

```bash
# If using Docker:
docker logs backend 2>&1 | grep -i "session\|revoked\|change-password" | tail -20

# Or if running locally:
npm start 2>&1 | grep -i "session\|revoked\|change-password"
```

**Look for:**
- `Session has been revoked` errors
- `sessions_revoked_at` comparisons
- JWT validation failures
- Exact error message with timestamp details

### 2.2 Query the Database

Check the current state of the admin user:

```sql
SELECT 
  user_id, 
  email, 
  password_hash,
  status, 
  must_change_password,
  sessions_revoked_at,
  last_login_at
FROM app_user 
WHERE email = 'admin@bmh.local';
```

**Look for:**
- Is `sessions_revoked_at` set to a timestamp or NULL?
- What is `must_change_password` (should be true)?
- What is the exact value of `sessions_revoked_at`?

### 2.3 Manually Test JWT Validation

Create a test endpoint to debug JWT claims:

**File:** `backend/src/routes/debug.ts` (create if doesn't exist)

```typescript
router.get('/debug/jwt-status', authenticateJWT, (req, res) => {
  // If this endpoint is reached, JWT passed validation
  res.json({
    message: 'JWT is valid',
    jwtPayload: req.user,
    timestamp: new Date().toISOString()
  });
});

// Add to server.ts:
// app.use('/debug', debugRouter);
```

Then make a request:

```bash
curl -H "Authorization: Bearer YOUR_JWT_HERE" http://localhost:3000/debug/jwt-status
```

If this returns an error, the JWT middleware is rejecting it. Check the console output for why.

---

## Step 3: Identify Root Cause

Based on investigation, root cause is likely one of these:

### **Root Cause A: sessions_revoked_at is too recent (timing race)**

**Symptom:** JWT was issued before `sessions_revoked_at` was set, but `sessions_revoked_at` was set to an earlier timestamp due to clock skew or order of operations.

**Fix:**

Clear the revocation timestamp so the current JWT is valid:

```sql
UPDATE app_user 
SET sessions_revoked_at = NULL 
WHERE user_id = 1;
```

Then try password change again with the same JWT. If it works, the issue was a timing race condition.

**To prevent this:** When reactivating an account, set `sessions_revoked_at` to a timestamp **in the past** (e.g., `NOW() - INTERVAL 1 MINUTE`), then issue a fresh JWT afterward:

```sql
-- Reactivate with past revocation time
UPDATE app_user 
SET 
  status = 'PENDING_PASSWORD_CHANGE',
  sessions_revoked_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE),
  failed_login_count = 0
WHERE user_id = 1;
```

Then user logs in fresh (JWT issued after this timestamp).

---

### **Root Cause B: Session check is inverted or broken**

**Symptom:** `sessions_revoked_at` exists and the middleware is rejecting ALL requests with a non-NULL `sessions_revoked_at`, regardless of JWT `iat`.

**Evidence to look for in middleware:**
```typescript
// ❌ WRONG: This rejects all sessions if revoked_at is set
if (user.sessions_revoked_at) {
  return res.status(401).json({ error: 'Session has been revoked' });
}

// ✅ CORRECT: Only reject if JWT was issued before revocation
if (user.sessions_revoked_at && decoded.iat < Math.floor(user.sessions_revoked_at.getTime() / 1000)) {
  return res.status(401).json({ error: 'Session has been revoked' });
}
```

**Fix:** Update the middleware to compare timestamps correctly:

```typescript
export const authenticateJWT = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Query user
    const user = await db.query(
      'SELECT sessions_revoked_at, status FROM app_user WHERE user_id = ?',
      [decoded.userId]
    );
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    // Check revocation: only reject if JWT was issued BEFORE revocation
    if (user.sessions_revoked_at) {
      const revokedAtSeconds = Math.floor(new Date(user.sessions_revoked_at).getTime() / 1000);
      if (decoded.iat < revokedAtSeconds) {
        return res.status(401).json({ error: 'Session has been revoked. Please sign in again.' });
      }
    }
    
    req.user = decoded;
    next();
  } catch (err) {
    console.error('JWT validation error:', err);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};
```

---

### **Root Cause C: Password change endpoint needs status check**

**Symptom:** Even if JWT passes, the password change endpoint itself might be checking `must_change_password` or `status` incorrectly.

**Fix:** Ensure endpoint allows password change when `must_change_password = true`:

```typescript
router.patch('/auth/change-password', authenticateJWT, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id;
  
  try {
    // Fetch user
    const user = await db.query(
      'SELECT password_hash, must_change_password, status FROM app_user WHERE user_id = ?',
      [userId]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // ✅ Allow if must_change_password OR status is PENDING_PASSWORD_CHANGE
    // ❌ Don't block just because sessions_revoked_at exists
    
    // Verify current password
    const passwordMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    // Hash and update
    const newHash = await bcrypt.hash(newPassword, 12);
    await db.query(
      `UPDATE app_user 
       SET password_hash = ?, 
           must_change_password = false,
           status = 'ACTIVE',
           sessions_revoked_at = NULL
       WHERE user_id = ?`,
      [newHash, userId]
    );
    
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

---

## Step 4: Implement Fix

### Option 1: Quick Fix (Database Only)

If the issue is purely timing/revocation state:

```sql
UPDATE app_user 
SET sessions_revoked_at = NULL,
    must_change_password = true,
    status = 'PENDING_PASSWORD_CHANGE'
WHERE user_id = 1;
```

Then try password change again with the existing JWT.

### Option 2: Backend Middleware Fix

If the middleware is checking `sessions_revoked_at` incorrectly, update it (see Root Cause B section above).

### Option 3: Complete Reactivation + Fresh Login

If timing is the issue, do a clean reactivation:

```sql
-- 1. Clear revocation and all session state
UPDATE app_user 
SET 
  status = 'PENDING_PASSWORD_CHANGE',
  sessions_revoked_at = NULL,
  must_change_password = true,
  failed_login_count = 0,
  locked_until = NULL
WHERE user_id = 1;
```

Then:
1. **Log in fresh:** `POST /auth/login` with credentials
2. **Receive new JWT** (issued after revocation was cleared)
3. **Change password:** `PATCH /auth/change-password` with new JWT

---

## Step 5: Verification

After applying fix, test the complete flow:

```bash
# 1. Log in
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bmh.local","password":"VerifyTest#2026"}'
# Response: { "token": "eyJ...", "user": { ... } }

# 2. Use JWT to change password
JWT="eyJ..." # from login response
curl -X PATCH http://localhost:3000/auth/change-password \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"VerifyTest#2026","newPassword":"NewSecurePass#2026"}'
# Response: { "success": true, "message": "Password changed successfully" }

# 3. Try logging in with new password
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bmh.local","password":"NewSecurePass#2026"}'
# Response: { "token": "eyJ...", "user": { ... } } with status: "ACTIVE"
```

---

## Implementation Checklist

- [ ] **Investigation Phase**
  - [ ] Locate middleware that checks `sessions_revoked_at`
  - [ ] Check backend logs for session revocation errors
  - [ ] Query database to see current admin user state
  - [ ] Manually test JWT with debug endpoint

- [ ] **Root Cause Identification**
  - [ ] Is middleware rejecting all sessions (inverted logic)?
  - [ ] Is timestamp comparison broken (timezone/units)?
  - [ ] Is JWT issued before `sessions_revoked_at` was set (timing race)?

- [ ] **Fix Implementation**
  - [ ] Apply quick DB fix (set `sessions_revoked_at = NULL`) OR
  - [ ] Fix middleware JWT comparison logic OR
  - [ ] Re-run reactivation query with proper timing

- [ ] **Verification**
  - [ ] Log in fresh (get new JWT)
  - [ ] Call password change endpoint with JWT
  - [ ] Verify password change succeeds (status → ACTIVE, must_change_password → false)
  - [ ] Log in with new password

---

## Notes

- **Do NOT bypass JWT validation entirely** — it's there for security
- **The issue is likely timing, not permission** — admin has ADMIN role, password change should be allowed
- **Check logs first** — they'll show exactly which validation is failing and why
- **Sessions_revoked_at should be rare** — only used when user password is compromised or account is locked
- **Verify timestamps are in UTC** — timezone bugs can cause off-by-one comparison issues

---

**Estimated effort:** 30 mins (investigation) + 15 mins (fix) = 45 mins total  
**Priority:** High — blocking admin login completion

