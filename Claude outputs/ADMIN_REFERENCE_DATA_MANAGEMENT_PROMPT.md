# Admin Reference Data Management & Report Filter Integration

**Feature:** Admin-controlled reference data layer (Customer Group, Distribution Channel, Company) that feeds all report filters  
**Goal:** Reports read from admin-managed clean data, not raw ETL; admins can customize reference data without code changes  
**Architecture:** ETL → Admin Clean Layer → Report Filters (& Salesperson Admin Page)  

---

## The Problem & Solution

### Current State (Broken)
```
ETL Data (Dim_Segment: b2b, b2c, back office)
  ↓
  ↓ (Reports read directly from here)
  ↓
Report Filters (stuck with raw ETL names/values)
```

### Desired State (Fixed)
```
ETL Data (b2b, b2c, back office)
  ↓
  ↓ (Admin organizes & links)
  ↓
Admin Clean Layer (admin_customer_group, admin_distribution_channel, admin_company)
  ├─ Name: "B2B" (admin-friendly)
  ├─ Definition: "Business to business"
  └─ ETL Relation: [dropdown: b2b]
  ↓
  ↓ (Reports & filters read from here)
  ↓
Report Filters + Salesperson Admin Page (clean, customizable data)
```

---

## Reference Data Tables to Create

### 1. Admin Customer Group Mapping

**Table:** `admin_customer_group`

```sql
CREATE TABLE admin_customer_group (
    customer_group_id   BIGINT AUTO_INCREMENT PRIMARY KEY,
    name                VARCHAR(100) NOT NULL UNIQUE,      -- "B2B", "B2C", "Back Office", etc.
    definition          VARCHAR(500),                       -- "Business to business", etc.
    etl_segment_key     INT NULL,                          -- FK to Dim_Segment (b2b=1, b2c=2, etc.)
    display_order       INT DEFAULT 0,                      -- Sort order in dropdowns
    is_active           BOOLEAN DEFAULT TRUE,               -- Soft delete (keep for history)
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by          INT NULL,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by          INT NULL,
    FOREIGN KEY (etl_segment_key) REFERENCES Dim_Segment(segment_key),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    INDEX idx_active (is_active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Seed data:**
```sql
INSERT INTO admin_customer_group (name, definition, etl_segment_key, display_order) VALUES
('B2B', 'Business to business sales', 1, 1),
('B2C', 'Business to consumer sales', 2, 2),
('Back Office', 'Internal operations and back office', 3, 3),
('Inter Company', 'Inter-company transfers', 4, 4);
```

### 2. Admin Distribution Channel Mapping

**Table:** `admin_distribution_channel`

```sql
CREATE TABLE admin_distribution_channel (
    distribution_channel_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name                    VARCHAR(100) NOT NULL UNIQUE,  -- "Retail", "Projects", "Wholesale", etc.
    definition              VARCHAR(500),                   -- Description
    etl_channel_key         INT NULL,                      -- FK to Dim_DistributionChannel
    display_order           INT DEFAULT 0,
    is_active               BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by              INT NULL,
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by              INT NULL,
    FOREIGN KEY (etl_channel_key) REFERENCES Dim_DistributionChannel(channel_key),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    INDEX idx_active (is_active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Seed data:**
```sql
INSERT INTO admin_distribution_channel (name, definition, etl_channel_key, display_order) VALUES
('Retail', 'Retail distribution channel', 1, 1),
('Projects', 'Project-based distribution', 2, 2),
('Wholesale', 'Wholesale/bulk distribution', 3, 3);
```

### 3. Admin Company Mapping

**Table:** `admin_company`

```sql
CREATE TABLE admin_company (
    company_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    name                VARCHAR(100) NOT NULL UNIQUE,      -- "BMH", "Majaal", "Tika", etc.
    definition          VARCHAR(500),                       -- "Al Baraka Majaal Holdings", etc.
    etl_company_key     INT NULL,                          -- FK to Dim_Company
    display_order       INT DEFAULT 0,
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by          INT NULL,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by          INT NULL,
    FOREIGN KEY (etl_company_key) REFERENCES Dim_Company(company_key),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    INDEX idx_active (is_active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Seed data:**
```sql
INSERT INTO admin_company (name, definition, etl_company_key, display_order) VALUES
('BMH', 'Al Baraka Majaal Holdings', 1, 1),
('Majaal', 'Majaal Subsidiary', 2, 2),
('Tika', 'Tika Subsidiary', 3, 3);
```

### 4. Admin History Tables (Audit Trail)

For each table above, create a `_history` table to track changes:

```sql
CREATE TABLE admin_customer_group_history (
    history_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    customer_group_id   BIGINT,
    name                VARCHAR(100),
    definition          VARCHAR(500),
    etl_segment_key     INT,
    action              ENUM('INSERT', 'UPDATE', 'DELETE'),
    changed_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    changed_by          INT,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_customer_group (customer_group_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

*(Create similar tables for distribution_channel and company)*

---

## Backend Services

### Reference Data Services

**File:** `backend/src/services/referenceDataService.ts`

```typescript
// Customer Group methods
async listCustomerGroups(includeInactive: boolean = false) {
  const whereClause = includeInactive ? '' : 'WHERE is_active = 1';
  const [rows] = await pool.query(
    `SELECT customer_group_id, name, definition, etl_segment_key, display_order, is_active
     FROM admin_customer_group
     ${whereClause}
     ORDER BY display_order ASC, name ASC`
  );
  return rows;
}

async getCustomerGroupByEtlKey(etlSegmentKey: number) {
  const [rows] = await pool.query(
    'SELECT * FROM admin_customer_group WHERE etl_segment_key = ? AND is_active = 1 LIMIT 1',
    [etlSegmentKey]
  );
  return (rows as any)[0];
}

async createCustomerGroup(data: { name: string; definition?: string; etl_segment_key?: number }, actorUserId: number) {
  // Validate unique name
  const [check] = await pool.query('SELECT 1 FROM admin_customer_group WHERE name = ? LIMIT 1', [data.name]);
  if ((check as any).length) {
    throw new ValidationError('Customer group name already exists');
  }

  // Validate ETL relation
  if (data.etl_segment_key) {
    const [segCheck] = await pool.query('SELECT 1 FROM Dim_Segment WHERE segment_key = ? LIMIT 1', [data.etl_segment_key]);
    if (!(segCheck as any).length) {
      throw new ValidationError('Invalid ETL segment key');
    }
  }

  const [result] = await pool.query(
    'INSERT INTO admin_customer_group (name, definition, etl_segment_key, created_by) VALUES (?, ?, ?, ?)',
    [data.name, data.definition || null, data.etl_segment_key || null, actorUserId]
  );

  // Log to history
  await pool.query(
    'INSERT INTO admin_customer_group_history (customer_group_id, name, definition, etl_segment_key, action, changed_by) VALUES (?, ?, ?, ?, ?, ?)',
    [(result as any).insertId, data.name, data.definition || null, data.etl_segment_key || null, 'INSERT', actorUserId]
  );

  return { customer_group_id: (result as any).insertId, ...data };
}

async updateCustomerGroup(id: number, data: { name?: string; definition?: string; etl_segment_key?: number }, actorUserId: number) {
  // Get current record
  const [current] = await pool.query('SELECT * FROM admin_customer_group WHERE customer_group_id = ? LIMIT 1', [id]);
  if (!(current as any).length) {
    throw new NotFoundError('Customer group not found');
  }

  const updates: string[] = [];
  const values: any[] = [];

  if (data.name) {
    const [check] = await pool.query('SELECT 1 FROM admin_customer_group WHERE name = ? AND customer_group_id != ? LIMIT 1', [data.name, id]);
    if ((check as any).length) {
      throw new ValidationError('Customer group name already exists');
    }
    updates.push('name = ?');
    values.push(data.name);
  }

  if (data.definition !== undefined) {
    updates.push('definition = ?');
    values.push(data.definition);
  }

  if (data.etl_segment_key !== undefined) {
    if (data.etl_segment_key) {
      const [segCheck] = await pool.query('SELECT 1 FROM Dim_Segment WHERE segment_key = ? LIMIT 1', [data.etl_segment_key]);
      if (!(segCheck as any).length) {
        throw new ValidationError('Invalid ETL segment key');
      }
    }
    updates.push('etl_segment_key = ?');
    values.push(data.etl_segment_key || null);
  }

  updates.push('updated_by = ?');
  values.push(actorUserId);
  values.push(id);

  await pool.query(`UPDATE admin_customer_group SET ${updates.join(', ')} WHERE customer_group_id = ?`, values);

  // Log to history
  await pool.query(
    'INSERT INTO admin_customer_group_history (customer_group_id, name, definition, etl_segment_key, action, changed_by) VALUES (?, ?, ?, ?, ?, ?)',
    [id, data.name || (current as any)[0].name, data.definition !== undefined ? data.definition : (current as any)[0].definition, 
     data.etl_segment_key !== undefined ? data.etl_segment_key : (current as any)[0].etl_segment_key, 'UPDATE', actorUserId]
  );
}

async deleteCustomerGroup(id: number, actorUserId: number) {
  // Hard delete (no soft delete for reference data)
  await pool.query('DELETE FROM admin_customer_group WHERE customer_group_id = ?', [id]);

  // Log to history
  await pool.query(
    'INSERT INTO admin_customer_group_history (customer_group_id, action, changed_by) VALUES (?, ?, ?)',
    [id, 'DELETE', actorUserId]
  );
}

// Same methods for Distribution Channel and Company...
```

---

## Backend Routes

### Reference Data Endpoints

**File:** `backend/src/routes/admin/reference-data.ts`

```typescript
router.get('/admin/reference-data/customer-groups', requireAuth, async (req, res, next) => {
  try {
    const groups = await referenceDataService.listCustomerGroups(false);
    res.json({ rows: groups });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/reference-data/customer-groups', requireAuth, requirePasswordChangeCleared, requirePermission('admin_reference_data', 'create'), async (req, res, next) => {
  try {
    const result = await referenceDataService.createCustomerGroup(req.body, req.user?.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/reference-data/customer-groups/:id', requireAuth, requirePasswordChangeCleared, requirePermission('admin_reference_data', 'edit'), async (req, res, next) => {
  try {
    await referenceDataService.updateCustomerGroup(parseInt(req.params.id), req.body, req.user?.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/admin/reference-data/customer-groups/:id', requireAuth, requirePasswordChangeCleared, requirePermission('admin_reference_data', 'delete'), async (req, res, next) => {
  try {
    await referenceDataService.deleteCustomerGroup(parseInt(req.params.id), req.user?.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Similar for distribution-channels and companies...
```

**Add to `server.ts`:**
```typescript
app.use('/admin/reference-data', adminReferenceDataRouter);
```

---

## Frontend Admin Pages

### Customer Group Admin Page

**File:** `frontend/src/app/admin/reference-data/customer-groups/page.tsx`

```typescript
'use client';

import { PermissionGuard } from '@/components/PermissionGuard';
import { AdminLayout } from '@/components/AdminLayout';
import { DataTable, Button, Input, Select } from '@07ps/ui';
import { useState, useEffect } from 'react';

export default function CustomerGroupsPage() {
  const [rows, setRows] = useState([]);
  const [etlOptions, setEtlOptions] = useState([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({ name: '', definition: '', etl_segment_key: '' });

  useEffect(() => {
    loadCustomerGroups();
    loadEtlSegments();
  }, []);

  const loadCustomerGroups = async () => {
    try {
      const res = await fetch('/admin/reference-data/customer-groups');
      const data = await res.json();
      setRows(data.rows || []);
    } catch (err) {
      console.error('Failed to load customer groups:', err);
    }
  };

  const loadEtlSegments = async () => {
    try {
      const res = await fetch('/filters/customer-groups');
      const data = await res.json();
      setEtlOptions(data.options || []);
    } catch (err) {
      console.error('Failed to load ETL segments:', err);
    }
  };

  const handleCreateGroup = async () => {
    try {
      if (!formData.name) {
        alert('Name is required');
        return;
      }

      await fetch('/admin/reference-data/customer-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      setShowCreateForm(false);
      setFormData({ name: '', definition: '', etl_segment_key: '' });
      loadCustomerGroups();
    } catch (err) {
      console.error('Failed to create customer group:', err);
      alert('Error creating customer group');
    }
  };

  return (
    <PermissionGuard pageKey="admin_reference_data">
      <AdminLayout title="Reference Data Management">
        <div style={{ padding: '16px' }}>
          <h2>Customer Groups</h2>
          <p style={{ color: '#888', marginBottom: '16px' }}>
            Manage customer group definitions and map them to ETL data.
          </p>

          <Button onClick={() => setShowCreateForm(!showCreateForm)} style={{ marginBottom: '16px' }}>
            + Add Customer Group
          </Button>

          {showCreateForm && (
            <div style={{ padding: '16px', marginBottom: '16px', border: '1px solid #ddd' }}>
              <Input
                placeholder="Name (e.g., B2B)"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                style={{ marginBottom: '12px' }}
              />
              <Input
                placeholder="Definition"
                value={formData.definition}
                onChange={(e) => setFormData({ ...formData, definition: e.target.value })}
                style={{ marginBottom: '12px' }}
              />
              <Select
                options={etlOptions}
                value={formData.etl_segment_key}
                onChange={(e) => setFormData({ ...formData, etl_segment_key: e.target.value })}
                placeholder="ETL Relation (optional)"
                style={{ marginBottom: '12px' }}
              />
              <Button onClick={handleCreateGroup}>Save</Button>
              <Button onClick={() => setShowCreateForm(false)} style={{ marginLeft: '8px' }}>Cancel</Button>
            </div>
          )}

          <DataTable
            columns={[
              { accessorKey: 'name', header: 'Name' },
              { accessorKey: 'definition', header: 'Definition' },
              { accessorKey: 'etl_segment_key', header: 'ETL Relation', cell: (info) => {
                const segmentName = etlOptions.find(o => o.value === info.getValue())?.label;
                return segmentName || '—';
              }},
              {
                id: 'actions',
                header: 'Actions',
                cell: (info) => (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => handleEdit(info.row.original)}>Edit</button>
                    <button onClick={() => handleDelete(info.row.original.customer_group_id)} style={{ color: 'red' }}>Delete</button>
                  </div>
                )
              },
            ]}
            data={rows}
          />
        </div>
      </AdminLayout>
    </PermissionGuard>
  );
}
```

*(Create similar pages for Distribution Channels and Companies)*

---

## Report Filter Integration

### Update Filter Endpoints

**File:** `backend/src/routes/filters.ts`

Instead of reading from `Dim_Segment`, `Dim_DistributionChannel`, `Dim_Company`, they should now read from the admin tables and fallback to ETL if not found:

```typescript
router.get('/filters/customer-groups', async (req, res) => {
  try {
    // Read from admin layer first
    const [adminGroups] = await pool.query(
      'SELECT customer_group_id as value, name as label FROM admin_customer_group WHERE is_active = 1 ORDER BY display_order'
    );

    // Fallback: if no admin data, read from ETL
    if (!(adminGroups as any).length) {
      const [etlGroups] = await pool.query(
        'SELECT segment_key as value, segment_name as label FROM Dim_Segment ORDER BY segment_key'
      );
      return res.json({ options: etlGroups });
    }

    res.json({ options: adminGroups });
  } catch (err) {
    next(err);
  }
});

router.get('/filters/distribution-channels', async (req, res) => {
  try {
    const [adminChannels] = await pool.query(
      'SELECT distribution_channel_id as value, name as label FROM admin_distribution_channel WHERE is_active = 1 ORDER BY display_order'
    );

    if (!(adminChannels as any).length) {
      const [etlChannels] = await pool.query(
        'SELECT channel_key as value, distribution_channel_name as label FROM Dim_DistributionChannel ORDER BY channel_key'
      );
      return res.json({ options: etlChannels });
    }

    res.json({ options: adminChannels });
  } catch (err) {
    next(err);
  }
});

router.get('/filters/companies', async (req, res) => {
  try {
    const [adminCompanies] = await pool.query(
      'SELECT company_id as value, name as label FROM admin_company WHERE is_active = 1 ORDER BY display_order'
    );

    if (!(adminCompanies as any).length) {
      const [etlCompanies] = await pool.query(
        'SELECT company_key as value, company_name as label FROM Dim_Company ORDER BY company_key'
      );
      return res.json({ options: etlCompanies });
    }

    res.json({ options: adminCompanies });
  } catch (err) {
    next(err);
  }
});
```

### Salesperson Filters in Reports

When reporting filters include "Filter by Salesperson", those filters should automatically include the salesperson's admin profile data:

```typescript
// In report measures (e.g., tachometer.ts)
if (salespersonKey) {
  // Load salesperson's admin profile
  const [profile] = await pool.query(
    `SELECT 
       COALESCE(sap.team_key_override, sp.sales_team_key) as team_key,
       COALESCE(sap.segment_key_override, sp.segment_key_default) as segment_key,
       COALESCE(sap.channel_key_override, sp.channel_key_default) as channel_key,
       sap.target_override_amount
     FROM Dim_Salesperson sp
     LEFT JOIN salesperson_admin_profile sap ON sp.salesperson_key = sap.salesperson_key
     WHERE sp.salesperson_key = ?`,
    [salespersonKey]
  );

  // Use these overrides in report calculations
  if (profile && profile.length) {
    filters.segmentKey = profile[0].segment_key;
    filters.channelKey = profile[0].channel_key;
    filters.teamKey = profile[0].team_key;
    // ... use in WHERE clause
  }
}
```

---

## User Inactivation: Delete Only (No Inactive Toggle)

### Update User Service

**File:** `backend/src/services/userService.ts`

Remove any "inactivate" method. For users:
- No soft delete toggle
- Only hard delete option (with cascade handling for audit trails)

**Update delete method:**
```typescript
async deleteUser(userId: number, actorUserId: number) {
  // Validate: cannot delete self
  if (userId === actorUserId) {
    throw new ValidationError('Cannot delete your own user account');
  }

  // Before delete: log to audit table (don't delete audit trail)
  const [user] = await pool.query('SELECT email, role FROM app_user WHERE user_id = ?', [userId]);
  
  await pool.query(
    'INSERT INTO user_deletion_audit (user_id, email, role, deleted_at, deleted_by) VALUES (?, ?, ?, NOW(), ?)',
    [userId, (user as any)[0]?.email, (user as any)[0]?.role, actorUserId]
  );

  // Delete user
  await pool.query('DELETE FROM app_user WHERE user_id = ?', [userId]);
}
```

### Frontend: Remove Inactive Toggle

**In user edit form:** Remove any "is_active" toggle or "Inactivate" button. Show only "Delete" button.

---

## Summary of Changes

| Component | Action | Files |
|-----------|--------|-------|
| **Database** | Create 3 admin tables + 3 history tables | `0017_admin_reference_data.sql` |
| **Backend Service** | CRUD for customer groups, dist channels, companies | `referenceDataService.ts` |
| **Backend Routes** | GET/POST/PATCH/DELETE for reference data + update filters | `admin/reference-data.ts`, `filters.ts` |
| **Frontend Pages** | Admin pages for customer groups, dist channels, companies | `admin/reference-data/*` |
| **Filters Integration** | Report filters read from admin tables, fallback to ETL | `filters.ts` |
| **Salesperson Filters** | Automatic override from salesperson admin profile | `tachometer.ts` + other measures |
| **User Deletion** | Remove inactive toggle, delete only | `userService.ts` + frontend |

---

## Data Flow

```
ETL Refresh (ODOO data arrives)
  ↓
Dim_Segment, Dim_DistributionChannel, Dim_Company (fully replaced)
  ↓
Admin Reference Data Pages (Admin creates mapping)
  ├─ Customer Group: "B2B" → links to Dim_Segment.b2b
  ├─ Distribution Channel: "Retail" → links to Dim_DistributionChannel.retail
  └─ Company: "Majaal" → links to Dim_Company.majaal
  ↓
Report Filter Endpoints (read admin tables first)
  ├─ /filters/customer-groups → admin_customer_group
  ├─ /filters/distribution-channels → admin_distribution_channel
  └─ /filters/companies → admin_company
  ↓
Report Measures & Dashboards
  ├─ Filters use admin-cleaned data
  └─ Salesperson filters automatically include overrides from salesperson_admin_profile
```

---

## Success Criteria

✅ Admin can create/edit/delete Customer Groups with ETL mapping  
✅ Admin can create/edit/delete Distribution Channels with ETL mapping  
✅ Admin can create/edit/delete Companies with ETL mapping  
✅ Report filters read from admin tables (with ETL fallback)  
✅ Salesperson filters automatically use admin profile overrides (team, CG, DC, target)  
✅ Users can only be deleted, not inactivated  
✅ All changes logged to history tables for audit  
✅ Permission system controls who can manage reference data  

---

**Ready to implement:** Hand this to your developer. This creates the "clean data layer" between ETL and reports that admins fully control.
