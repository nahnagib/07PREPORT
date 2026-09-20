# Fix: Empty Data Tables & Add Create Buttons

**Issue:** Sales Team and Salesperson tables display structure but all data columns are empty (showing dashes)  
**Root Cause:** Backend queries not returning actual data from dimension tables, or frontend not mapping fields correctly  
**Solution:** Wire data layer properly + add Create functionality to both tables  

---

## Problem Statement

**Current UI:**
- Tables load and display (rows exist)
- **All value columns are empty** (Code, Name, Target, Customer Group show "—" dashes)
- No "Create Team" or "Create Salesperson" buttons
- Tables show structure but no actionable data

**Expected behavior:**
- Code, Name, Target, Customer Group populate from database
- Fallback to live `Dim_SalesTeam` / `Dim_Salesperson` when overlay is NULL
- "Create Team" button to add new teams
- "Create Salesperson" button to add new salespersons
- Data refreshes after edit/create

---

## Root Causes

### Backend Issue: Queries Not Joining Properly

Current `listSalesTeams()` likely does:
```typescript
SELECT * FROM sales_team_admin_profile  // ❌ Only returns overlay; live dims are separate
```

**Should do:**
```typescript
SELECT
  st.sales_team_key,
  COALESCE(stap.team_name_override, st.sales_team_name) as sales_team_name,  // Fallback to live name
  stap.team_code,
  stap.target_override_amount,
  COALESCE(stap.segment_key_override, st.segment_key_default) as segment_key_override,
  ds.segment_name,
  stap.updated_at,
  u.email as updated_by_email
FROM Dim_SalesTeam st
LEFT JOIN sales_team_admin_profile stap ON st.sales_team_key = stap.sales_team_key
LEFT JOIN Dim_Segment ds ON COALESCE(stap.segment_key_override, st.segment_key_default) = ds.segment_key
LEFT JOIN app_user u ON stap.updated_by = u.user_id
WHERE st.is_active = 1
ORDER BY st.sales_team_name ASC
```

**Same pattern for `listSalespersons()`:**
```typescript
SELECT
  sp.salesperson_key,
  sp.salesperson_name,
  COALESCE(sapp.sales_team_key_override, sp.sales_team_key) as sales_team_key_override,
  COALESCE(sapp.channel_key_override, sp.channel_key_default) as channel_key_override,
  dc.distribution_channel_name as channel_label,
  COALESCE(sapp.segment_key_override, sp.segment_key_default) as segment_key_override,
  ds.segment_name as segment_label,
  sapp.target_override_amount,
  sapp.updated_at,
  u.email as updated_by_email
FROM Dim_Salesperson sp
LEFT JOIN salesperson_admin_profile sapp ON sp.salesperson_key = sapp.salesperson_key
LEFT JOIN Dim_DistributionChannel dc ON COALESCE(sapp.channel_key_override, sp.channel_key_default) = dc.channel_key
LEFT JOIN Dim_Segment ds ON COALESCE(sapp.segment_key_override, sp.segment_key_default) = ds.segment_key
LEFT JOIN app_user u ON sapp.updated_by = u.user_id
WHERE sp.is_active = 1
ORDER BY sp.salesperson_name ASC
```

### Frontend Issue: Missing Field Mappings

Frontend columns reference fields that don't exist or aren't being returned:
```typescript
{ accessorKey: 'sales_team_name', header: 'Name' },  // ❌ Field doesn't exist in response
```

**Actual response field names are snake_case with prefixes:**
- `sales_team_name` (correct)
- `team_code` (correct)
- `target_override_amount` (correct)
- `segment_label` (correct)

But the queries aren't returning these — the backend is returning only the overlay table columns, not the joined data.

---

## Implementation Steps

### Step 1: Fix Backend Queries

**File:** `backend/src/services/salesTeamAdminService.ts`

Update `listSalesTeams()`:
```typescript
async listSalesTeams(
  filters: { segmentKey?: number; search?: string },
  pagination: { page: number; pageSize: number }
): Promise<{ rows: SalesTeamAdminRow[]; total: number }> {
  const offset = (pagination.page - 1) * pagination.pageSize;

  const whereConditions = ['st.is_active = 1'];
  const params: any[] = [];

  if (filters.search) {
    whereConditions.push('(st.sales_team_name LIKE ? OR stap.team_code LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  if (filters.segmentKey !== undefined) {
    whereConditions.push(
      'COALESCE(stap.segment_key_override, st.segment_key_default) = ?'
    );
    params.push(filters.segmentKey);
  }

  const whereClause = whereConditions.join(' AND ');

  // Get total count
  const countQuery = `
    SELECT COUNT(*) as total
    FROM Dim_SalesTeam st
    LEFT JOIN sales_team_admin_profile stap ON st.sales_team_key = stap.sales_team_key
    WHERE ${whereClause}
  `;
  const [countResult] = await pool.query(countQuery, params);
  const total = (countResult as any)[0].total;

  // Get paginated data with all fields
  const dataQuery = `
    SELECT
      st.sales_team_key,
      COALESCE(stap.team_name_override, st.sales_team_name) as sales_team_name,
      stap.team_code,
      stap.target_override_amount,
      COALESCE(stap.segment_key_override, st.segment_key_default) as segment_key_override,
      ds.segment_name as segment_label,
      stap.updated_at,
      u.email as updated_by_email
    FROM Dim_SalesTeam st
    LEFT JOIN sales_team_admin_profile stap ON st.sales_team_key = stap.sales_team_key
    LEFT JOIN Dim_Segment ds ON COALESCE(stap.segment_key_override, st.segment_key_default) = ds.segment_key
    LEFT JOIN app_user u ON stap.updated_by = u.user_id
    WHERE ${whereClause}
    ORDER BY st.sales_team_name ASC
    LIMIT ? OFFSET ?
  `;

  const [rows] = await pool.query(dataQuery, [...params, pagination.pageSize, offset]);

  return { rows: rows as SalesTeamAdminRow[], total };
}
```

**Do the same for `listSalespersons()`** in `backend/src/services/salespersonAdminService.ts`.

### Step 2: Add Create Endpoints

**File:** `backend/src/routes/admin/salesteams.ts`

Add POST endpoint:
```typescript
router.post('/admin/salesteams', requireAuth, requirePasswordChangeCleared, requirePermission('admin_salesteams', 'view'), async (req, res, next) => {
  try {
    const { sales_team_key, team_code, target_override_amount, segment_key_override, note } = req.body;
    const actorUserId = req.user?.id;

    // Validation
    if (!sales_team_key) {
      return res.status(400).json({ error: 'sales_team_key is required' });
    }

    // Check if team exists in Dim_SalesTeam
    const [teamCheck] = await pool.query(
      'SELECT 1 FROM Dim_SalesTeam WHERE sales_team_key = ? LIMIT 1',
      [sales_team_key]
    );
    if (!(teamCheck as any).length) {
      return res.status(404).json({ error: 'Sales team not found' });
    }

    // Check unique team_code
    if (team_code) {
      const [codeCheck] = await pool.query(
        'SELECT 1 FROM sales_team_admin_profile WHERE team_code = ? AND sales_team_key != ? LIMIT 1',
        [team_code, sales_team_key]
      );
      if ((codeCheck as any).length) {
        return res.status(400).json({ error: 'Team code already exists' });
      }
    }

    // Validate segment if provided
    if (segment_key_override) {
      const [segmentCheck] = await pool.query(
        'SELECT 1 FROM Dim_Segment WHERE segment_key = ? LIMIT 1',
        [segment_key_override]
      );
      if (!(segmentCheck as any).length) {
        return res.status(400).json({ error: 'Invalid segment key' });
      }
    }

    // Insert into overlay table
    await pool.query(
      `INSERT INTO sales_team_admin_profile (sales_team_key, team_code, target_override_amount, segment_key_override, note, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       team_code = VALUES(team_code),
       target_override_amount = VALUES(target_override_amount),
       segment_key_override = VALUES(segment_key_override),
       note = VALUES(note),
       updated_by = VALUES(updated_by)`,
      [sales_team_key, team_code || null, target_override_amount || null, segment_key_override || null, note || null, actorUserId]
    );

    // Insert into history
    await pool.query(
      `INSERT INTO sales_team_admin_profile_history (sales_team_key, team_code, target_override_amount, segment_key_override, note, changed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sales_team_key, team_code || null, target_override_amount || null, segment_key_override || null, note || null, actorUserId]
    );

    res.json({ success: true, message: 'Sales team created' });
  } catch (err) {
    next(err);
  }
});
```

**Do the same for `backend/src/routes/admin/salespersons.ts`** with POST endpoint for creating salespersons.

### Step 3: Add Create Buttons to Frontend

**File:** `frontend/src/app/admin/salesteams/page.tsx`

```typescript
'use client';

import { PermissionGuard } from '@/components/PermissionGuard';
import { AdminLayout } from '@/components/AdminLayout';
import { DataTable, Button, Input, Select } from '@07ps/ui';
import { useState, useEffect } from 'react';
import { adminApi } from '@/lib/api';

export default function SalesTeamsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({
    sales_team_key: '',
    team_code: '',
    target_override_amount: '',
    segment_key_override: '',
  });
  const [segments, setSegments] = useState([]);

  useEffect(() => {
    loadSalesTeams();
    loadSegments();
  }, []);

  const loadSalesTeams = async () => {
    try {
      setLoading(true);
      const data = await adminApi.listSalesTeams({}, { page: 1, pageSize: 50 });
      setRows(data.rows || []);
    } catch (err) {
      console.error('Failed to load sales teams:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadSegments = async () => {
    try {
      // Reuse existing segments endpoint
      const data = await fetch('/api/filters/customer-groups').then(r => r.json());
      setSegments(data.options || []);
    } catch (err) {
      console.error('Failed to load segments:', err);
    }
  };

  const handleCreateTeam = async () => {
    try {
      if (!formData.sales_team_key) {
        alert('Sales team is required');
        return;
      }

      await adminApi.createSalesTeam(formData);
      setShowCreateForm(false);
      setFormData({ sales_team_key: '', team_code: '', target_override_amount: '', segment_key_override: '' });
      loadSalesTeams();
    } catch (err) {
      console.error('Failed to create team:', err);
      alert('Error creating team: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  return (
    <PermissionGuard pageKey="admin_salesteams">
      <AdminLayout title="Sales Team Management">
        <div style={{ padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h2>Sales Team Management</h2>
            <Button onClick={() => setShowCreateForm(!showCreateForm)} variant="primary">
              + Create Team
            </Button>
          </div>

          {showCreateForm && (
            <div style={{ 
              padding: '16px', 
              marginBottom: '16px', 
              border: '1px solid var(--ps-color-border)',
              borderRadius: '4px',
              backgroundColor: 'var(--ps-color-background-secondary)'
            }}>
              <h3>Create New Sales Team</h3>
              
              <div style={{ marginBottom: '12px' }}>
                <label>Sales Team *</label>
                <Input
                  placeholder="Team name or ID"
                  value={formData.sales_team_key}
                  onChange={(e) => setFormData({ ...formData, sales_team_key: e.target.value })}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label>Code</label>
                <Input
                  placeholder="Unique team code"
                  value={formData.team_code}
                  onChange={(e) => setFormData({ ...formData, team_code: e.target.value })}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label>Target</label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={formData.target_override_amount}
                  onChange={(e) => setFormData({ ...formData, target_override_amount: e.target.value })}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label>Customer Group</label>
                <Select
                  options={segments}
                  value={formData.segment_key_override}
                  onChange={(e) => setFormData({ ...formData, segment_key_override: e.target.value })}
                />
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <Button onClick={handleCreateTeam} variant="primary">Save</Button>
                <Button onClick={() => setShowCreateForm(false)} variant="secondary">Cancel</Button>
              </div>
            </div>
          )}

          <p style={{ color: '#888', marginBottom: '16px' }}>
            Edit sales team code, target, and customer group.
          </p>

          {loading ? (
            <p>Loading...</p>
          ) : (
            <DataTable
              columns={[
                { accessorKey: 'sales_team_name', header: 'Name' },
                { accessorKey: 'team_code', header: 'Code' },
                { accessorKey: 'target_override_amount', header: 'Target', cell: (info) => {
                  const val = info.getValue();
                  return val ? `$${Number(val).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—';
                }},
                { accessorKey: 'segment_label', header: 'Customer Group' },
                {
                  id: 'actions',
                  header: 'Actions',
                  cell: () => <button style={{ color: 'var(--ps-color-primary)', cursor: 'pointer' }}>Edit</button>
                },
              ]}
              data={rows}
            />
          )}
        </div>
      </AdminLayout>
    </PermissionGuard>
  );
}
```

### Step 4: Update API Client

**File:** `frontend/src/lib/api.ts`

Add method:
```typescript
const adminApi = {
  // ... existing methods
  
  createSalesTeam: (data: Partial<SalesTeamAdminRow>) =>
    fetch('/admin/salesteams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(res => res.ok ? res.json() : res.json().then(e => Promise.reject(e))),

  createSalesperson: (data: Partial<SalespersonAdminRow>) =>
    fetch('/admin/salespersons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(res => res.ok ? res.json() : res.json().then(e => Promise.reject(e))),
};
```

---

## Verification Checklist

- [ ] Backend: `listSalesTeams()` query returns actual `sales_team_name`, `team_code`, `target_override_amount`, `segment_label`
- [ ] Backend: `listSalespersons()` query returns actual `salesperson_name`, `sales_team_key`, `channel_label`, `segment_label`, `target_override_amount`
- [ ] Frontend: Open `/admin/salesteams` → table rows show real values (not dashes)
- [ ] Frontend: Open `/admin/salespersons` → table rows show real values
- [ ] Frontend: Click "+ Create Team" button → form appears
- [ ] Frontend: Fill form, click Save → new team appears in table (after refresh)
- [ ] Frontend: Click "+ Create Salesperson" button → form appears
- [ ] Frontend: Fill form, click Save → new salesperson appears in table

---

## Files to Update

| File | Action | Change |
|------|--------|--------|
| `backend/src/services/salesTeamAdminService.ts` | MODIFY | Fix `listSalesTeams()` query to join with Dim_SalesTeam + Dim_Segment |
| `backend/src/services/salespersonAdminService.ts` | MODIFY | Fix `listSalespersons()` query to join with Dim_Salesperson + dimensions |
| `backend/src/routes/admin/salesteams.ts` | MODIFY | Add POST endpoint for creating teams |
| `backend/src/routes/admin/salespersons.ts` | MODIFY | Add POST endpoint for creating salespersons |
| `frontend/src/app/admin/salesteams/page.tsx` | MODIFY | Add Create form + button + proper data mapping |
| `frontend/src/app/admin/salespersons/page.tsx` | MODIFY | Add Create form + button + proper data mapping |
| `frontend/src/lib/api.ts` | MODIFY | Add `createSalesTeam()` + `createSalesperson()` methods |

---

## Success Criteria

✅ Tables populate with actual data from dimension tables  
✅ Fallback to live dim data when overlay is NULL  
✅ "Create Team" button works and adds new team  
✅ "Create Salesperson" button works and adds new person  
✅ Code, Name, Target, Customer Group display real values (not dashes)  
✅ All CRUD operations log to history tables  
✅ TypeScript strict mode passes  
✅ No console errors  

---

**Ready to build:** This prompt has all backend queries, frontend forms, and API methods needed. Implement in order: Backend queries first, then routes, then frontend forms.
