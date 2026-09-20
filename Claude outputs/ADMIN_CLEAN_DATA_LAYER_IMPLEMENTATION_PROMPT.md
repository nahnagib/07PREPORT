# Implementation Prompt: Admin-Controlled Clean Data Layer for Reports

**Project:** BMH 07 BI Report Dashboard — Reference Data Management  
**Objective:** Create admin-controlled reference data management system that serves as the single source of truth for all report filters  
**Status:** Ready for implementation  
**Priority:** BLOCKING — All report filters depend on this layer  

---

## Executive Summary

Currently, report filters read directly from ETL tables (Dim_CustomerGroup, Dim_DistributionChannel, Dim_Company), which are fully replaced on every ETL refresh. This creates two problems:

1. **Admins cannot add custom reference data** (e.g., a new customer group not in ODOO)
2. **Report data quality depends entirely on ETL** with no intermediate control layer

**Solution:** Create an admin-controlled **clean data layer** that:
- Manages Customer Groups, Distribution Channels, and Companies
- Links each admin-managed item to its corresponding ETL source (if it exists)
- Allows admins to add new items beyond what ETL provides
- Becomes the **single source of truth** for all report filters
- Survives ETL refreshes (like salesperson/sales team overlay tables)

**Filter Flow (Current):**
```
ETL (Dim_*) → Report Filters → User sees raw ETL data
```

**Filter Flow (After Implementation):**
```
ETL (Dim_*) → Admin Clean Data Layer → Report Filters → User sees admin-curated data
```

---

## 1. Core Architecture

### 1.1 Three Admin Reference Tables

Each table follows the same pattern: name + definition + ETL relation + active status + audit fields.

#### **admin_customer_group**
```sql
CREATE TABLE IF NOT EXISTS admin_customer_group (
    customer_group_id       INT AUTO_INCREMENT PRIMARY KEY,
    name                    VARCHAR(100) NOT NULL UNIQUE,          -- "B2B", "B2C", "Back Office", etc.
    definition              VARCHAR(500),                          -- "Business-to-business sales"
    etl_segment_key         INT NULL,                              -- FK to Dim_Segment.SegmentKey (1=B2B, 2=B2C, 3=Back Office, 4=Inter Company, 5=Unknown)
    etl_segment_name        VARCHAR(100),                          -- Cached name from Dim_Segment for display
    display_order           INT DEFAULT 0,                         -- Sort order in dropdowns
    is_active               BOOLEAN DEFAULT true,                  -- SOFT DELETE ONLY (no hard delete)
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by              INT,                                   -- User ID
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by              INT,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    INDEX idx_active (is_active),
    INDEX idx_display_order (display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_customer_group_history (
    history_id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    customer_group_id       INT NOT NULL,
    name                    VARCHAR(100),
    definition              VARCHAR(500),
    etl_segment_key         INT NULL,
    etl_segment_name        VARCHAR(100),
    display_order           INT,
    is_active               BOOLEAN,
    action                  ENUM('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE'),
    changed_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    changed_by              INT,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_customer_group_id (customer_group_id),
    INDEX idx_changed_at (changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

#### **admin_distribution_channel**
```sql
CREATE TABLE IF NOT EXISTS admin_distribution_channel (
    distribution_channel_id INT AUTO_INCREMENT PRIMARY KEY,
    name                    VARCHAR(100) NOT NULL UNIQUE,          -- "Retail", "Projects", "Wholesale", etc.
    definition              VARCHAR(500),                          -- "Channel description"
    etl_channel_key         INT NULL,                              -- FK to Dim_DistributionChannel.ChannelKey
    etl_channel_name        VARCHAR(100),                          -- Cached name from Dim_DistributionChannel
    display_order           INT DEFAULT 0,
    is_active               BOOLEAN DEFAULT true,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by              INT,
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by              INT,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    INDEX idx_active (is_active),
    INDEX idx_display_order (display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_distribution_channel_history (
    history_id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    distribution_channel_id INT NOT NULL,
    name                    VARCHAR(100),
    definition              VARCHAR(500),
    etl_channel_key         INT NULL,
    etl_channel_name        VARCHAR(100),
    display_order           INT,
    is_active               BOOLEAN,
    action                  ENUM('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE'),
    changed_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    changed_by              INT,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_distribution_channel_id (distribution_channel_id),
    INDEX idx_changed_at (changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

#### **admin_company**
```sql
CREATE TABLE IF NOT EXISTS admin_company (
    company_id              INT AUTO_INCREMENT PRIMARY KEY,
    name                    VARCHAR(100) NOT NULL UNIQUE,          -- "BMH", "BMH Subsidiary", etc.
    definition              VARCHAR(500),                          -- "Company description"
    etl_company_key         VARCHAR(64) NULL,                      -- FK to Dim_Company.CompanyKey
    etl_company_name        VARCHAR(100),                          -- Cached name from Dim_Company
    display_order           INT DEFAULT 0,
    is_active               BOOLEAN DEFAULT true,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by              INT,
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by              INT,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    INDEX idx_active (is_active),
    INDEX idx_display_order (display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_company_history (
    history_id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    company_id              INT NOT NULL,
    name                    VARCHAR(100),
    definition              VARCHAR(500),
    etl_company_key         VARCHAR(64) NULL,
    etl_company_name        VARCHAR(100),
    display_order           INT,
    is_active               BOOLEAN,
    action                  ENUM('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE'),
    changed_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    changed_by              INT,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_company_id (company_id),
    INDEX idx_changed_at (changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 2. Admin Interface (Frontend Pages)

### 2.1 Customer Groups Admin Page
**Path:** `/admin/reference-data/customer-groups/page.tsx`

**UX Flow:**
1. Page loads with list of all customer groups (active + inactive)
2. Each row shows:
   - **Name** (editable text)
   - **Definition** (editable text)
   - **ETL Relation** (read-only badge showing "B2B" if linked to etl_segment_key=1, or "—" if admin-created)
   - **Display Order** (editable number, default 0)
   - **Status** (Active/Inactive toggle — can deactivate only if NOT used by salesperson/team, else show warning)
   - **Actions** (Edit, Deactivate, Delete)

3. Inline Edit Panel (on row click):
   - Name field (text input)
   - Definition field (textarea)
   - ETL Relation dropdown (shows "Dim_Segment values: 1=B2B, 2=B2C, 3=Back Office, 4=Inter Company, 5=Unknown, or None")
   - Display Order (number)
   - Save button → PATCH /admin/reference-data/customer-groups/:id
   - Cancel button

4. Create New Button (top right):
   - Form overlay: Name, Definition, ETL Relation (dropdown), Display Order
   - Validation: name unique, name not empty, definition optional, etl_segment_key must exist in Dim_Segment if selected
   - Submit → POST /admin/reference-data/customer-groups

5. Delete behavior:
   - Soft delete (mark is_active=false)
   - Cannot delete if used by any salesperson_admin_profile (validation error: "This customer group is assigned to N salespersons. Deactivate instead.")
   - Hard delete: only if NEVER assigned (show "Delete permanently" option after soft delete if no usage)

**Sample UI state after loading:**
```
=== Customer Group Management ===

[+ Create Customer Group]

Name          | Definition                  | ETL Relation | Order | Status    | Actions
B2B           | Business-to-business sales  | B2B (ETL)    | 1     | Active    | Edit | Deactivate
B2C           | Business-to-consumer sales  | B2C (ETL)    | 2     | Active    | Edit | Deactivate
Back Office   | Internal operations         | Back Office (ETL) | 3 | Active | Edit | Deactivate
Premium Plus  | Custom admin-created        | —            | 4     | Active    | Edit | Deactivate | Delete
Inactive Old  | No longer used              | —            | 0     | Inactive  | Reactivate | Delete
```

### 2.2 Distribution Channels Admin Page
**Path:** `/admin/reference-data/distribution-channels/page.tsx`

**Identical structure to Customer Groups, but:**
- Columns: Name, Definition, ETL Relation (shows Dim_DistributionChannel values: Retail, Projects, Wholesale, Unknown), Display Order, Status, Actions
- POST/PATCH to `/admin/reference-data/distribution-channels`
- Validation: etl_channel_key must exist in Dim_DistributionChannel if selected

### 2.3 Companies Admin Page
**Path:** `/admin/reference-data/companies/page.tsx`

**Identical structure to Customer Groups, but:**
- Columns: Name, Definition, ETL Relation (shows Dim_Company values from ETL), Display Order, Status, Actions
- POST/PATCH to `/admin/reference-data/companies`
- Validation: etl_company_key must exist in Dim_Company if selected

---

## 3. Backend Service Layer

### 3.1 Customer Group Service
**File:** `backend/src/services/customerGroupAdminService.ts`

```typescript
interface CreateCustomerGroupInput {
  name: string;                    // Required, unique
  definition?: string;             // Optional
  etlSegmentKey?: number;          // Optional, must exist in Dim_Segment
  displayOrder?: number;           // Default 0
}

interface UpdateCustomerGroupInput {
  name?: string;
  definition?: string;
  etlSegmentKey?: number;
  displayOrder?: number;
  isActive?: boolean;              // For deactivation only
}

class CustomerGroupAdminService {
  /**
   * List all customer groups (active + inactive)
   */
  async listCustomerGroups(filters?: {
    isActive?: boolean;
    search?: string;
  }, pagination?: { page: number; pageSize: number }) {
    // GET with optional filtering
    // Returns: { rows: [...], total, page, pageSize }
  }

  /**
   * Create new customer group
   */
  async createCustomerGroup(input: CreateCustomerGroupInput, userId: number) {
    // Validation:
    // - name must be unique (check admin_customer_group)
    // - name not empty
    // - definition optional
    // - if etlSegmentKey provided, must exist in Dim_Segment (LEFT JOIN to verify)
    // - displayOrder defaults to 0
    //
    // Insert into admin_customer_group
    // Insert into admin_customer_group_history with action='CREATE'
    // Return: { id, name, definition, etlSegmentKey, displayOrder, createdAt, createdBy }
  }

  /**
   * Update customer group
   */
  async updateCustomerGroup(id: number, input: UpdateCustomerGroupInput, userId: number) {
    // Validation:
    // - if name changed, must be unique (excluding current row)
    // - if isActive=false (deactivation), check if used by salesperson_admin_profile
    //   - If used, throw error: "This customer group is assigned to N salespersons"
    // - if etlSegmentKey changed, must exist in Dim_Segment
    //
    // Update admin_customer_group
    // Insert into admin_customer_group_history with action='UPDATE' or 'DEACTIVATE'
    // Return: updated row
  }

  /**
   * Deactivate customer group
   */
  async deactivateCustomerGroup(id: number, userId: number) {
    // Set is_active = false
    // Insert history with action='DEACTIVATE'
  }

  /**
   * Hard delete (use with extreme caution)
   */
  async deleteCustomerGroup(id: number, userId: number) {
    // Check no salesperson/team references
    // Delete from admin_customer_group
    // Insert into admin_customer_group_history with action='DELETE' (for audit)
    // Soft delete fallback: if DELETE not allowed, return 400 with reason
  }

  /**
   * Get ETL segment dropdown values
   */
  async getEtlSegmentOptions() {
    // SELECT SegmentKey, SegmentName FROM Dim_Segment ORDER BY SegmentKey
    // Returns: [{ key: 1, name: 'B2B' }, { key: 2, name: 'B2C' }, ...]
  }
}
```

### 3.2 Distribution Channel Service & Company Service
**Files:** 
- `backend/src/services/distributionChannelAdminService.ts`
- `backend/src/services/companyAdminService.ts`

Identical to CustomerGroupAdminService, with s/Segment/Channel/, s/Segment/Company/, etc.

---

## 4. Backend API Routes

### 4.1 Customer Groups Routes
**File:** `backend/src/routes/admin/reference-data/customerGroups.ts`

```typescript
/**
 * GET /admin/reference-data/customer-groups?isActive=true&search=B2B&page=1&pageSize=50
 * List all customer groups with optional filtering
 */
router.get('/', async (req, res) => {
  const { isActive, search, page = 1, pageSize = 50 } = req.query;
  const result = await customerGroupService.listCustomerGroups(
    { isActive: isActive === 'true' ? true : undefined, search },
    { page: Number(page), pageSize: Number(pageSize) }
  );
  res.json(result);
});

/**
 * POST /admin/reference-data/customer-groups
 * Create new customer group
 */
router.post('/', async (req, res) => {
  const input = req.body; // { name, definition, etlSegmentKey, displayOrder }
  const userId = req.user.id; // From session middleware
  try {
    const newGroup = await customerGroupService.createCustomerGroup(input, userId);
    res.status(201).json(newGroup);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PATCH /admin/reference-data/customer-groups/:id
 * Update customer group
 */
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const input = req.body; // { name?, definition?, etlSegmentKey?, displayOrder?, isActive? }
  const userId = req.user.id;
  try {
    const updated = await customerGroupService.updateCustomerGroup(Number(id), input, userId);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /admin/reference-data/customer-groups/:id
 * Hard delete (only if no references)
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  try {
    await customerGroupService.deleteCustomerGroup(Number(id), userId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /admin/reference-data/customer-groups/etl-options
 * Get available ETL segment values for dropdown
 */
router.get('/etl-options', async (req, res) => {
  const options = await customerGroupService.getEtlSegmentOptions();
  res.json(options);
});
```

### 4.2 Distribution Channels & Companies Routes
**Files:**
- `backend/src/routes/admin/reference-data/distributionChannels.ts`
- `backend/src/routes/admin/reference-data/companies.ts`

Same pattern, mounted at `/admin/reference-data/distribution-channels` and `/admin/reference-data/companies`

### 4.3 Mount all routes in server.ts
```typescript
import customerGroupsRouter from './routes/admin/reference-data/customerGroups';
import distributionChannelsRouter from './routes/admin/reference-data/distributionChannels';
import companiesRouter from './routes/admin/reference-data/companies';

app.use('/admin/reference-data/customer-groups', customerGroupsRouter);
app.use('/admin/reference-data/distribution-channels', distributionChannelsRouter);
app.use('/admin/reference-data/companies', companiesRouter);
```

---

## 5. Filter Integration (Reports)

### 5.1 Filter Endpoints Now Read from Admin Layer

**Current:** `/filters/customer-groups` → queries Dim_Segment directly

**Updated:** `/filters/customer-groups` → queries admin_customer_group first, falls back to Dim_Segment

#### **GET /filters/customer-groups**
```typescript
async (req, res) => {
  // 1. Try admin layer first (read active only)
  let rows = await db.query(`
    SELECT customer_group_id as id, name, definition, display_order
    FROM admin_customer_group
    WHERE is_active = true
    ORDER BY display_order, name
  `);

  // 2. If admin layer is empty, fallback to ETL (for migration period)
  if (rows.length === 0) {
    rows = await db.query(`
      SELECT SegmentKey as id, SegmentName as name, NULL as definition, 0 as display_order
      FROM Dim_Segment
      WHERE SegmentKey IN (1, 2, 3, 4)
      ORDER BY SegmentKey
    `);
  }

  res.json({ rows });
}
```

#### **GET /filters/distribution-channels**
```typescript
// Same pattern: read from admin_distribution_channel first, fallback to Dim_DistributionChannel
```

#### **GET /filters/companies**
```typescript
// Same pattern: read from admin_company first, fallback to Dim_Company
```

---

## 6. Salesperson Filter Integration

The salesperson admin profile already defines overrides:
- `sales_team_key_override` (Team Related)
- `segment_key_override` (Customer Group)
- `channel_key_override` (Distribution Channel)

**Now, report measures must read from salesperson admin profile when available.**

### 6.1 Example Report Filter Query (Salesperson Context)

**Current measure query (if salesperson-filtered):**
```sql
SELECT 
  SUM(Fact_Sales.SalesAmount) as YearToDateSales
FROM Fact_Sales
JOIN Dim_Salesperson ON Fact_Sales.SalespersonKey = Dim_Salesperson.SalespersonKey
WHERE Dim_Salesperson.SalespersonKey = @salespersonKey
  AND YEAR(Fact_Sales.SalesDate) = YEAR(CURDATE())
```

**Updated with admin profile override:**
```sql
SELECT 
  SUM(Fact_Sales.SalesAmount) as YearToDateSales
FROM Fact_Sales
JOIN Dim_Salesperson ON Fact_Sales.SalespersonKey = Dim_Salesperson.SalespersonKey
LEFT JOIN salesperson_admin_profile ON Dim_Salesperson.SalespersonKey = salesperson_admin_profile.salesperson_key
WHERE Dim_Salesperson.SalespersonKey = @salespersonKey
  AND YEAR(Fact_Sales.SalesDate) = YEAR(CURDATE())
  -- Apply customer group filter if admin override exists
  AND (
    COALESCE(salesperson_admin_profile.segment_key_override, Dim_Salesperson.SegmentKey, 5) 
    IN (@customerGroupIds)  -- from report filter
    OR salesperson_admin_profile.segment_key_override IS NULL AND Dim_Salesperson.SegmentKey IN (@customerGroupIds)
  )
```

---

## 7. User Deletion: Soft Delete Only (No Inactive Toggle)

### 7.1 Current Issue
User admin interface has an "Inactive" toggle, allowing soft delete. Users requested: **no inactive toggle, only delete option**.

### 7.2 Changes Required

#### Backend (userAdminService.ts)
```typescript
/**
 * Delete user (hard delete with audit)
 * @param userId - User to delete
 * @param actorUserId - Admin performing delete
 */
async deleteUser(userId: number, actorUserId: number) {
  // 1. Log deletion in user_deletion_history (audit table)
  await db.query(`
    INSERT INTO user_deletion_history 
      (user_id, user_email, deleted_at, deleted_by)
    SELECT user_id, email, NOW(), ?
    FROM app_user WHERE user_id = ?
  `, [actorUserId, userId]);

  // 2. Delete user records
  // - DELETE FROM app_user WHERE user_id = ?
  // - DELETE FROM user_role WHERE user_id = ? (cascade)
  // - DELETE FROM user_login_history WHERE user_id = ? (cascade, optional)
  // - etc.

  // 3. If salesperson_key was linked, clear it but keep history
  await db.query(`
    INSERT INTO user_salesperson_change_history 
      (user_id, salesperson_key, action, changed_at, changed_by)
    SELECT user_id, salesperson_key, 'UNLINKED_ON_DELETE', NOW(), ?
    FROM app_user WHERE user_id = ?
  `, [actorUserId, userId]);

  await db.query(`
    UPDATE app_user SET salesperson_key = NULL WHERE user_id = ?
  `, [userId]);
}
```

#### Frontend (Admin Users Page)
**Remove:** "Inactive" toggle button  
**Add:** "Delete" button (red, with confirmation dialog)

```typescript
// OLD: 
// <button onClick={() => toggleInactive(user.id)}>Toggle Inactive</button>

// NEW:
<button 
  onClick={() => deleteUser(user.id)}
  style={{ background: 'red', color: 'white' }}
>
  Delete User
</button>

// Confirmation dialog:
// "Are you sure you want to permanently delete this user? This action cannot be undone."
```

---

## 8. Implementation Checklist

### Database
- [ ] Migration: Create admin_customer_group + history table
- [ ] Migration: Create admin_distribution_channel + history table
- [ ] Migration: Create admin_company + history table
- [ ] Verify all FKs to Dim_* tables are correct
- [ ] Seed admin tables with ETL data (optional, for initial data):
  ```sql
  INSERT INTO admin_customer_group (name, definition, etl_segment_key, display_order)
  SELECT DISTINCT SegmentName, NULL, SegmentKey, SegmentKey
  FROM Dim_Segment
  WHERE SegmentKey IN (1, 2, 3, 4);
  ```

### Backend Services
- [ ] CustomerGroupAdminService: listCustomerGroups, createCustomerGroup, updateCustomerGroup, deleteCustomerGroup, getEtlSegmentOptions
- [ ] DistributionChannelAdminService: (same pattern)
- [ ] CompanyAdminService: (same pattern)
- [ ] userAdminService.deleteUser() updated (no soft delete, hard delete with audit)

### Backend Routes
- [ ] GET/POST/PATCH/DELETE /admin/reference-data/customer-groups
- [ ] GET/POST/PATCH/DELETE /admin/reference-data/distribution-channels
- [ ] GET/POST/PATCH/DELETE /admin/reference-data/companies
- [ ] Mount all routes in server.ts
- [ ] Test: POST create, PATCH update, DELETE hard delete, GET list

### Filter Endpoints
- [ ] GET /filters/customer-groups reads from admin_customer_group first, fallback to Dim_Segment
- [ ] GET /filters/distribution-channels reads from admin_distribution_channel first, fallback to Dim_DistributionChannel
- [ ] GET /filters/companies reads from admin_company first, fallback to Dim_Company

### Frontend Pages
- [ ] `/admin/reference-data/customer-groups/page.tsx` with DataTable, inline edit, create form, deactivate/delete
- [ ] `/admin/reference-data/distribution-channels/page.tsx` (same pattern)
- [ ] `/admin/reference-data/companies/page.tsx` (same pattern)
- [ ] AdminLayout.tsx: Add three new tabs to TABS array
  ```typescript
  { label: 'Customer Groups', href: '/admin/reference-data/customer-groups', pageKey: 'admin_customer_groups' },
  { label: 'Distribution Channels', href: '/admin/reference-data/distribution-channels', pageKey: 'admin_distribution_channels' },
  { label: 'Companies', href: '/admin/reference-data/companies', pageKey: 'admin_companies' },
  ```
- [ ] API methods in frontend/src/lib/api.ts:
  ```typescript
  adminApi.listCustomerGroups(filters, pagination)
  adminApi.createCustomerGroup(input)
  adminApi.updateCustomerGroup(id, input)
  adminApi.deleteCustomerGroup(id)
  adminApi.listDistributionChannels(filters, pagination)
  adminApi.createDistributionChannel(input)
  // ... etc.
  ```
- [ ] Each page wrapped in `<PermissionGuard pageKey="admin_customer_groups" />` (or equivalent)

### Integration
- [ ] Report filter dropdowns use new admin endpoints (✓ if backend updated)
- [ ] Salesperson report queries use COALESCE with admin profile overrides
- [ ] Sales Team report queries use COALESCE with admin profile overrides
- [ ] Test: Admin creates custom customer group → appears in report filter dropdown

### User Deletion
- [ ] Remove "Inactive" toggle from user admin page
- [ ] Add "Delete" button with confirmation
- [ ] Backend userAdminService.deleteUser() hard deletes with audit trail
- [ ] Test: Delete user → cannot log in, audit trail preserved

### Verification
- [ ] Admin page loads without errors (F12 console)
- [ ] Can create customer group with name + definition + ETL link
- [ ] Can update customer group inline
- [ ] Cannot delete if used by salesperson (validation error shown)
- [ ] Can deactivate unused customer group
- [ ] Report filter dropdown shows admin-managed data
- [ ] Salesperson profile overrides respected in report measures
- [ ] User deletion removes all user data, preserves audit trail
- [ ] TypeScript: `tsc --noEmit` passes

---

## 9. Data Flow Example: "B2B Override"

**Scenario:** Admin creates custom customer group "B2B Premium" not in ODOO, links to ETL B2B.

**ETL State:**
```
Dim_Segment: SegmentKey=1, SegmentName='B2B'
```

**Admin Action:**
1. Admin navigates to `/admin/reference-data/customer-groups`
2. Clicks "+ Create Customer Group"
3. Enters: Name="B2B Premium", Definition="Premium B2B accounts", ETL Relation="1 (B2B)"
4. Clicks Save → POST /admin/reference-data/customer-groups

**Database Result:**
```sql
admin_customer_group:
  customer_group_id: 42
  name: 'B2B Premium'
  definition: 'Premium B2B accounts'
  etl_segment_key: 1
  etl_segment_name: 'B2B'
  is_active: true

admin_customer_group_history:
  action: 'CREATE'
  changed_by: (admin user id)
```

**Report Behavior:**
1. Report page loads → calls GET /filters/customer-groups
2. Backend queries admin_customer_group (active only) → returns B2B Premium
3. Report filter dropdown shows: ["B2B Premium"] (not "B2B", because admin layer is now authoritative)
4. User selects "B2B Premium" in report
5. Report queries measure WHERE segment_key_override=1 OR segment_key=1

---

## 10. Notes & Assumptions

- **ETL is immutable:** Dim_* tables fully replaced on refresh; admin tables survive
- **Admin layer is authoritative:** Once admin_customer_group is populated, report filters ignore Dim_Segment
- **Fallback for migration:** If admin tables are empty, filters read from ETL (bridges old & new behavior)
- **Soft delete only:** Customer groups/channels/companies can be deactivated but not hard-deleted if in use
- **Hard delete for users only:** Users have no "inactive" toggle; admins can only delete (irreversible, audited)
- **History for compliance:** All actions logged to *_history tables for audit trail
- **No user-controlled creation:** Admins can only link existing ETL data or add custom items; ETL data remains read-only source of truth

---

## 11. Success Criteria

✅ Admin can CRUD customer groups, distribution channels, companies  
✅ Each admin item can link to ETL source (dropdown) or stand alone  
✅ Report filters read from admin layer, not directly from ETL  
✅ Salesperson/Team profile overrides automatically apply to report filters  
✅ User admin page has no "inactive" toggle; delete only  
✅ All changes audited in *_history tables  
✅ TypeScript strict mode passes  
✅ No console errors on admin reference data pages  

---

**Status:** ✅ Ready for implementation  
**Estimated effort:** 12–16 hours (services, routes, frontend pages, integration, testing)  
**Dependencies:** Salesperson/Sales Team admin pages already exist; reference data tables are independent

