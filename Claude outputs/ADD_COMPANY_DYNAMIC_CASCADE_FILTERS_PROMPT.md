# Enhancement: Add Company Field & Dynamic Cascading Filters

**Status:** Enhancement request  
**Priority:** High — Completes organizational hierarchy  
**Scope:** 
1. Add Company field to salesperson and sales team admin profiles
2. Implement dynamic cascading filters in reports
3. Filters auto-restrict based on company selection

---

## Problem Statement

**Current state:**
- Admin can edit salesperson: name, team, customer group, distribution channel, target
- Admin can edit sales team: name, code, customer group, target
- Report filters are independent: selecting company doesn't restrict salesperson options
- **Missing:** Organizational context (which company does each person/team belong to?)

**Desired state:**
- Salesperson admin profile includes: Company (editable)
- Sales Team admin profile includes: Company (editable)
- Report filters cascade dynamically:
  1. User selects **Company** → filters available customer groups, distribution channels, teams, salespersons to that company
  2. User selects **Customer Group** → further narrows teams and salespersons
  3. User selects **Distribution Channel** → further narrows teams and salespersons
  4. User selects **Branch (Sales Team)** → shows only salespersons in that team
  5. User selects **Salesperson** → report shows that person's data

---

## Data Model Changes

### 1. Extend Admin Profile Tables

#### **salesperson_admin_profile**

Add company field:

```sql
ALTER TABLE salesperson_admin_profile
ADD COLUMN company_id INT NULL AFTER salesperson_key,
ADD FOREIGN KEY (company_id) REFERENCES admin_company(company_id);

-- Also add company_id to history table
ALTER TABLE salesperson_admin_profile_history
ADD COLUMN company_id INT NULL AFTER salesperson_key;
```

**Updated schema:**
```sql
CREATE TABLE IF NOT EXISTS salesperson_admin_profile (
    salesperson_id              INT AUTO_INCREMENT PRIMARY KEY,
    salesperson_key             VARCHAR(64) NOT NULL UNIQUE,
    admin_name_override         VARCHAR(255) NULL,
    company_id                  INT NULL,                          -- ✨ NEW: Which company
    sales_team_key_override     VARCHAR(64) NULL,
    segment_key_override        INT NULL,                          -- Customer Group
    channel_key_override        INT NULL,                          -- Distribution Channel
    target_override_amount      DECIMAL(18,2) NULL,
    note                        VARCHAR(500) NULL,
    updated_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by                  INT NULL,
    FOREIGN KEY (company_id) REFERENCES admin_company(company_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    INDEX idx_company_id (company_id),
    INDEX idx_salesperson_key (salesperson_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

#### **sales_team_admin_profile**

Add company field:

```sql
ALTER TABLE sales_team_admin_profile
ADD COLUMN company_id INT NULL AFTER sales_team_key,
ADD FOREIGN KEY (company_id) REFERENCES admin_company(company_id);

-- Also add company_id to history table
ALTER TABLE sales_team_admin_profile_history
ADD COLUMN company_id INT NULL AFTER sales_team_key;
```

**Updated schema:**
```sql
CREATE TABLE IF NOT EXISTS sales_team_admin_profile (
    sales_team_id               INT AUTO_INCREMENT PRIMARY KEY,
    sales_team_key              VARCHAR(64) NOT NULL UNIQUE,
    company_id                  INT NULL,                          -- ✨ NEW: Which company
    team_code                   VARCHAR(50) NOT NULL,
    segment_key_override        INT NULL,                          -- Customer Group
    target_override_amount      DECIMAL(18,2) NULL,
    note                        VARCHAR(500) NULL,
    updated_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by                  INT NULL,
    FOREIGN KEY (company_id) REFERENCES admin_company(company_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    INDEX idx_company_id (company_id),
    INDEX idx_sales_team_key (sales_team_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## Database Migration

**File:** `backend/src/migrations/0018_add_company_to_profiles.sql`

```sql
-- Add company_id to salesperson_admin_profile
ALTER TABLE salesperson_admin_profile
ADD COLUMN company_id INT NULL AFTER salesperson_key,
ADD FOREIGN KEY fk_sap_company (company_id) REFERENCES admin_company(company_id) ON DELETE SET NULL;

-- Add company_id to salesperson_admin_profile_history
ALTER TABLE salesperson_admin_profile_history
ADD COLUMN company_id INT NULL AFTER salesperson_key;

-- Add company_id to sales_team_admin_profile
ALTER TABLE sales_team_admin_profile
ADD COLUMN company_id INT NULL AFTER sales_team_key,
ADD FOREIGN KEY fk_stap_company (company_id) REFERENCES admin_company(company_id) ON DELETE SET NULL;

-- Add company_id to sales_team_admin_profile_history
ALTER TABLE sales_team_admin_profile_history
ADD COLUMN company_id INT NULL AFTER sales_team_key;

-- Create indices for performance
CREATE INDEX idx_sap_company ON salesperson_admin_profile(company_id);
CREATE INDEX idx_stap_company ON sales_team_admin_profile(company_id);
```

---

## Backend Service Updates

### 1. Salesperson Admin Service

**File:** `backend/src/services/salespersonAdminService.ts`

Update methods to include company_id:

```typescript
interface CreateSalespersonProfileInput {
  salespersonKey: string;
  adminNameOverride?: string;
  companyId?: number;                    // ✨ NEW
  salesTeamKeyOverride?: string;
  segmentKeyOverride?: number;
  channelKeyOverride?: number;
  targetOverrideAmount?: number;
  note?: string;
}

interface UpdateSalespersonProfileInput {
  adminNameOverride?: string;
  companyId?: number;                    // ✨ NEW
  salesTeamKeyOverride?: string;
  segmentKeyOverride?: number;
  channelKeyOverride?: number;
  targetOverrideAmount?: number;
  note?: string;
}

class SalespersonAdminService {
  async listSalespersons(filters?: {
    search?: string;
    companyId?: number;                  // ✨ NEW: Filter by company
  }, pagination?: { page: number; pageSize: number }) {
    let query = `
      SELECT 
        sap.salesperson_id,
        sap.salesperson_key,
        sap.admin_name_override,
        sap.company_id,
        ac.name as company_name,         -- ✨ NEW: Show company name
        sap.sales_team_key_override,
        sap.segment_key_override,
        sap.channel_key_override,
        sap.target_override_amount,
        ds.SalespersonName as etl_name,
        dst.SalesTeamName as team_name,
        acg.name as segment_name,
        adc.name as channel_name
      FROM salesperson_admin_profile sap
      JOIN Dim_Salesperson ds ON sap.salesperson_key = ds.SalespersonKey
      LEFT JOIN Dim_SalesTeam dst ON sap.sales_team_key_override = dst.SalesTeamKey
      LEFT JOIN admin_company ac ON sap.company_id = ac.company_id           -- ✨ NEW
      LEFT JOIN admin_customer_group acg ON sap.segment_key_override = acg.customer_group_id
      LEFT JOIN admin_distribution_channel adc ON sap.channel_key_override = adc.distribution_channel_id
      WHERE 1=1
    `;

    if (filters?.companyId) {
      query += ` AND sap.company_id = ${filters.companyId}`;  // ✨ NEW: Filter by company
    }
    
    if (filters?.search) {
      query += ` AND (ds.SalespersonName LIKE '%${filters.search}%' OR sap.admin_name_override LIKE '%${filters.search}%')`;
    }

    // ... pagination, order by

    return { rows, total, page, pageSize };
  }

  async createSalespersonProfile(input: CreateSalespersonProfileInput, userId: number) {
    // Validate companyId exists in admin_company if provided
    if (input.companyId) {
      const company = await db.query('SELECT company_id FROM admin_company WHERE company_id = ?', [input.companyId]);
      if (!company) throw new Error('Company does not exist');
    }

    // Insert with company_id
    const result = await db.query(`
      INSERT INTO salesperson_admin_profile 
        (salesperson_key, admin_name_override, company_id, sales_team_key_override, 
         segment_key_override, channel_key_override, target_override_amount, note, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.salespersonKey,
      input.adminNameOverride,
      input.companyId,              // ✨ NEW
      input.salesTeamKeyOverride,
      input.segmentKeyOverride,
      input.channelKeyOverride,
      input.targetOverrideAmount,
      input.note,
      userId
    ]);

    // Insert history
    await db.query(`
      INSERT INTO salesperson_admin_profile_history
        (salesperson_id, salesperson_key, admin_name_override, company_id, ...)
      VALUES (?, ?, ?, ?, ...)
    `, [result.insertId, ...]);

    return result;
  }

  async updateSalespersonProfile(id: number, input: UpdateSalespersonProfileInput, userId: number) {
    // Validate companyId if changing
    if (input.companyId) {
      const company = await db.query('SELECT company_id FROM admin_company WHERE company_id = ?', [input.companyId]);
      if (!company) throw new Error('Company does not exist');
    }

    const updates = [];
    const values = [];

    if (input.adminNameOverride !== undefined) {
      updates.push('admin_name_override = ?');
      values.push(input.adminNameOverride);
    }

    if (input.companyId !== undefined) {                    // ✨ NEW
      updates.push('company_id = ?');
      values.push(input.companyId);
    }

    // ... other fields

    if (updates.length === 0) return;

    values.push(userId, id);
    await db.query(`
      UPDATE salesperson_admin_profile 
      SET ${updates.join(', ')}, updated_by = ?, updated_at = NOW()
      WHERE salesperson_id = ?
    `, values);

    // Insert history record
    // ...
  }

  /**
   * ✨ NEW: Get salespersons by company (for cascading filters)
   */
  async getSalespersonsByCompany(companyId: number) {
    return await db.query(`
      SELECT 
        sap.salesperson_id,
        sap.salesperson_key,
        COALESCE(sap.admin_name_override, ds.SalespersonName) as name,
        sap.company_id
      FROM salesperson_admin_profile sap
      JOIN Dim_Salesperson ds ON sap.salesperson_key = ds.SalespersonKey
      WHERE sap.company_id = ?
      ORDER BY COALESCE(sap.admin_name_override, ds.SalespersonName)
    `, [companyId]);
  }
}
```

### 2. Sales Team Admin Service

**File:** `backend/src/services/salesTeamAdminService.ts`

Update similarly to include company_id:

```typescript
async listSalesTeams(filters?: {
  companyId?: number;                    // ✨ NEW: Filter by company
}, pagination?: { page: number; pageSize: number }) {
  let query = `
    SELECT 
      stap.sales_team_id,
      stap.sales_team_key,
      stap.company_id,
      ac.name as company_name,           -- ✨ NEW
      stap.team_code,
      stap.segment_key_override,
      stap.target_override_amount,
      dst.SalesTeamName as etl_name,
      acg.name as segment_name
    FROM sales_team_admin_profile stap
    JOIN Dim_SalesTeam dst ON stap.sales_team_key = dst.SalesTeamKey
    LEFT JOIN admin_company ac ON stap.company_id = ac.company_id              -- ✨ NEW
    LEFT JOIN admin_customer_group acg ON stap.segment_key_override = acg.customer_group_id
    WHERE 1=1
  `;

  if (filters?.companyId) {
    query += ` AND stap.company_id = ${filters.companyId}`;  // ✨ NEW
  }

  // ... rest of implementation
}

/**
 * ✨ NEW: Get sales teams by company (for cascading filters)
 */
async getSalesTeamsByCompany(companyId: number) {
  return await db.query(`
    SELECT 
      stap.sales_team_id,
      stap.sales_team_key,
      stap.team_code as name,
      stap.company_id
    FROM sales_team_admin_profile stap
    WHERE stap.company_id = ?
    ORDER BY stap.team_code
  `, [companyId]);
}
```

---

## Backend API Routes (Cascading Filters)

### File: `backend/src/routes/filters.ts`

Add new endpoints for dynamic cascading:

```typescript
/**
 * ✨ NEW: GET /filters/customer-groups?companyId=1
 * Get customer groups available in a company
 * Filters based on which customer groups are used by teams/salespersons in that company
 */
router.get('/customer-groups', async (req, res) => {
  const { companyId } = req.query;

  if (!companyId) {
    // No company selected: return all active customer groups
    const rows = await db.query(`
      SELECT customer_group_id as id, name, definition
      FROM admin_customer_group
      WHERE is_active = true
      ORDER BY display_order, name
    `);
    return res.json({ rows });
  }

  // ✨ NEW: Filter to only groups used by this company's teams/salespersons
  const rows = await db.query(`
    SELECT DISTINCT acg.customer_group_id as id, acg.name, acg.definition
    FROM admin_customer_group acg
    WHERE acg.is_active = true
      AND (
        -- Groups assigned to teams in this company
        EXISTS (
          SELECT 1 FROM sales_team_admin_profile stap
          WHERE stap.company_id = ? AND stap.segment_key_override = acg.customer_group_id
        )
        OR
        -- Groups assigned to salespersons in this company
        EXISTS (
          SELECT 1 FROM salesperson_admin_profile sap
          WHERE sap.company_id = ? AND sap.segment_key_override = acg.customer_group_id
        )
      )
    ORDER BY acg.display_order, acg.name
  `, [companyId, companyId]);

  res.json({ rows });
});

/**
 * ✨ NEW: GET /filters/distribution-channels?companyId=1
 * Get distribution channels available in a company
 */
router.get('/distribution-channels', async (req, res) => {
  const { companyId } = req.query;

  if (!companyId) {
    const rows = await db.query(`
      SELECT distribution_channel_id as id, name
      FROM admin_distribution_channel
      WHERE is_active = true
      ORDER BY display_order, name
    `);
    return res.json({ rows });
  }

  // Filter to channels used in this company
  const rows = await db.query(`
    SELECT DISTINCT adc.distribution_channel_id as id, adc.name
    FROM admin_distribution_channel adc
    WHERE adc.is_active = true
      AND (
        EXISTS (
          SELECT 1 FROM sales_team_admin_profile stap
          WHERE stap.company_id = ? AND stap.channel_key_override = adc.distribution_channel_id
        )
        OR
        EXISTS (
          SELECT 1 FROM salesperson_admin_profile sap
          WHERE sap.company_id = ? AND sap.channel_key_override = adc.distribution_channel_id
        )
      )
    ORDER BY adc.display_order, adc.name
  `, [companyId, companyId]);

  res.json({ rows });
});

/**
 * ✨ NEW: GET /filters/teams?companyId=1&segmentId=1&channelId=1
 * Get sales teams (branches) available based on company and other filters
 */
router.get('/teams', async (req, res) => {
  const { companyId, segmentId, channelId } = req.query;

  let query = `
    SELECT DISTINCT 
      stap.sales_team_key as id,
      stap.team_code as name
    FROM sales_team_admin_profile stap
    WHERE 1=1
  `;

  if (companyId) {
    query += ` AND stap.company_id = ${companyId}`;
  }
  if (segmentId) {
    query += ` AND (stap.segment_key_override = ${segmentId} OR stap.segment_key_override IS NULL)`;
  }
  if (channelId) {
    query += ` AND (stap.channel_key_override = ${channelId} OR stap.channel_key_override IS NULL)`;
  }

  query += ` ORDER BY stap.team_code`;

  const rows = await db.query(query);
  res.json({ rows });
});

/**
 * ✨ NEW: GET /filters/salespersons?companyId=1&segmentId=1&channelId=1&teamId=1
 * Get salespersons available based on all selected filters
 */
router.get('/salespersons', async (req, res) => {
  const { companyId, segmentId, channelId, teamId } = req.query;

  let query = `
    SELECT DISTINCT 
      sap.salesperson_key as id,
      COALESCE(sap.admin_name_override, ds.SalespersonName) as name
    FROM salesperson_admin_profile sap
    JOIN Dim_Salesperson ds ON sap.salesperson_key = ds.SalespersonKey
    WHERE 1=1
  `;

  if (companyId) {
    query += ` AND sap.company_id = ${companyId}`;
  }
  if (segmentId) {
    query += ` AND (sap.segment_key_override = ${segmentId} OR sap.segment_key_override IS NULL)`;
  }
  if (channelId) {
    query += ` AND (sap.channel_key_override = ${channelId} OR sap.channel_key_override IS NULL)`;
  }
  if (teamId) {
    query += ` AND (sap.sales_team_key_override = '${teamId}' OR sap.sales_team_key_override IS NULL)`;
  }

  query += ` ORDER BY name`;

  const rows = await db.query(query);
  res.json({ rows });
});
```

---

## Frontend Admin Pages

### 1. Salesperson Admin Page Update

**File:** `frontend/src/app/admin/salespersons/page.tsx`

Add company field to table and edit form:

```typescript
// Table columns
columns={[
  { accessorKey: 'company_name', header: 'Company' },              // ✨ NEW
  { accessorKey: 'salesperson_name', header: 'Name' },
  { accessorKey: 'admin_name_override', header: 'Admin Name' },
  { accessorKey: 'team_name', header: 'Team Related' },
  { accessorKey: 'segment_name', header: 'Customer Group' },
  { accessorKey: 'channel_name', header: 'Distribution Channel' },
  { accessorKey: 'target_override_amount', header: 'Target' },
  // ... actions
]}

// Edit form
const [editData, setEditData] = useState({
  companyId: null,                         // ✨ NEW
  adminNameOverride: '',
  salesTeamKeyOverride: '',
  segmentKeyOverride: null,
  channelKeyOverride: null,
  targetOverrideAmount: null,
});

// In edit panel:
<select 
  value={editData.companyId || ''} 
  onChange={(e) => setEditData({...editData, companyId: e.target.value})}
>
  <option value="">-- Select Company --</option>
  {companies.map(c => (
    <option key={c.id} value={c.id}>{c.name}</option>
  ))}
</select>
```

### 2. Sales Team Admin Page Update

**File:** `frontend/src/app/admin/salesteams/page.tsx`

Same pattern: add company field to table and edit form.

---

## Frontend Report Filters (Cascading)

### File: `frontend/src/hooks/useReportFilters.ts`

Implement cascading logic:

```typescript
export const useReportFilters = () => {
  const [filters, setFilters] = useState({
    company: null,
    customerGroup: null,
    distributionChannel: null,
    team: null,
    salesperson: null,
  });

  const [options, setOptions] = useState({
    companies: [],
    customerGroups: [],
    distributionChannels: [],
    teams: [],
    salespersons: [],
  });

  // Load all companies (always available)
  useEffect(() => {
    loadCompanies();
  }, []);

  // Load customer groups when company changes
  useEffect(() => {
    if (filters.company) {
      loadCustomerGroups(filters.company);
    } else {
      setOptions(prev => ({ ...prev, customerGroups: [] }));
    }
  }, [filters.company]);

  // Load distribution channels when company changes
  useEffect(() => {
    if (filters.company) {
      loadDistributionChannels(filters.company);
    } else {
      setOptions(prev => ({ ...prev, distributionChannels: [] }));
    }
  }, [filters.company]);

  // Load teams when company/segment/channel change
  useEffect(() => {
    if (filters.company) {
      loadTeams({
        companyId: filters.company,
        segmentId: filters.customerGroup,
        channelId: filters.distributionChannel,
      });
    } else {
      setOptions(prev => ({ ...prev, teams: [] }));
    }
  }, [filters.company, filters.customerGroup, filters.distributionChannel]);

  // Load salespersons when all filters change
  useEffect(() => {
    if (filters.company) {
      loadSalespersons({
        companyId: filters.company,
        segmentId: filters.customerGroup,
        channelId: filters.distributionChannel,
        teamId: filters.team,
      });
    } else {
      setOptions(prev => ({ ...prev, salespersons: [] }));
    }
  }, [filters.company, filters.customerGroup, filters.distributionChannel, filters.team]);

  const loadCompanies = async () => {
    const data = await fetch('/api/filters/companies').then(r => r.json());
    setOptions(prev => ({ ...prev, companies: data.rows }));
  };

  const loadCustomerGroups = async (companyId) => {
    const data = await fetch(`/api/filters/customer-groups?companyId=${companyId}`).then(r => r.json());
    setOptions(prev => ({ ...prev, customerGroups: data.rows }));
    // Reset dependent filters
    setFilters(prev => ({ ...prev, customerGroup: null, distributionChannel: null, team: null, salesperson: null }));
  };

  const loadDistributionChannels = async (companyId) => {
    const data = await fetch(`/api/filters/distribution-channels?companyId=${companyId}`).then(r => r.json());
    setOptions(prev => ({ ...prev, distributionChannels: data.rows }));
  };

  const loadTeams = async ({ companyId, segmentId, channelId }) => {
    const params = new URLSearchParams({
      companyId: companyId || '',
      segmentId: segmentId || '',
      channelId: channelId || '',
    });
    const data = await fetch(`/api/filters/teams?${params}`).then(r => r.json());
    setOptions(prev => ({ ...prev, teams: data.rows }));
    // Reset dependent filters
    setFilters(prev => ({ ...prev, team: null, salesperson: null }));
  };

  const loadSalespersons = async ({ companyId, segmentId, channelId, teamId }) => {
    const params = new URLSearchParams({
      companyId: companyId || '',
      segmentId: segmentId || '',
      channelId: channelId || '',
      teamId: teamId || '',
    });
    const data = await fetch(`/api/filters/salespersons?${params}`).then(r => r.json());
    setOptions(prev => ({ ...prev, salespersons: data.rows }));
    // Reset dependent filter
    setFilters(prev => ({ ...prev, salesperson: null }));
  };

  return { filters, setFilters, options };
};
```

### Report Component Using Cascading Filters

```typescript
export function ReportFilters() {
  const { filters, setFilters, options } = useReportFilters();

  return (
    <div className="filters">
      {/* 1. Company (master filter) */}
      <select 
        value={filters.company || ''} 
        onChange={(e) => setFilters({...filters, company: e.target.value})}
      >
        <option value="">-- Select Company --</option>
        {options.companies.map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      {/* 2. Customer Group (enabled only if company selected) */}
      <select 
        value={filters.customerGroup || ''} 
        onChange={(e) => setFilters({...filters, customerGroup: e.target.value})}
        disabled={!filters.company}
      >
        <option value="">-- Select Customer Group --</option>
        {options.customerGroups.map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      {/* 3. Distribution Channel (enabled only if company selected) */}
      <select 
        value={filters.distributionChannel || ''} 
        onChange={(e) => setFilters({...filters, distributionChannel: e.target.value})}
        disabled={!filters.company}
      >
        <option value="">-- Select Distribution Channel --</option>
        {options.distributionChannels.map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      {/* 4. Branch/Team (enabled only if company selected) */}
      <select 
        value={filters.team || ''} 
        onChange={(e) => setFilters({...filters, team: e.target.value})}
        disabled={!filters.company}
      >
        <option value="">-- Select Branch (Team) --</option>
        {options.teams.map(t => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>

      {/* 5. Salesperson (enabled only if company selected) */}
      <select 
        value={filters.salesperson || ''} 
        onChange={(e) => setFilters({...filters, salesperson: e.target.value})}
        disabled={!filters.company}
      >
        <option value="">-- Select Salesperson --</option>
        {options.salespersons.map(s => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </div>
  );
}
```

---

## Implementation Checklist

### Database
- [ ] Migration 0018: Add company_id to salesperson_admin_profile + history
- [ ] Migration 0018: Add company_id to sales_team_admin_profile + history
- [ ] Create indices on company_id for performance
- [ ] Seed initial data (assign companies to existing teams/salespersons if needed)

### Backend Services
- [ ] SalespersonAdminService: Add companyId to create/update input
- [ ] SalespersonAdminService: Add companyId filtering to list method
- [ ] SalespersonAdminService: Add getSalespersonsByCompany() method
- [ ] SalesTeamAdminService: Same updates
- [ ] Validate companyId exists before insert/update

### Backend Routes
- [ ] GET /filters/customer-groups?companyId=X (dynamic filtering)
- [ ] GET /filters/distribution-channels?companyId=X (dynamic filtering)
- [ ] GET /filters/teams?companyId=X&segmentId=X&channelId=X
- [ ] GET /filters/salespersons?companyId=X&segmentId=X&channelId=X&teamId=X
- [ ] Ensure existing report endpoints still work

### Frontend Admin Pages
- [ ] Admin Salesperson page: Add company dropdown to table and edit form
- [ ] Admin Salesperson page: Save company_id when editing
- [ ] Admin Sales Team page: Add company dropdown to table and edit form
- [ ] Admin Sales Team page: Save company_id when editing

### Frontend Report Filters
- [ ] Implement useReportFilters hook with cascading logic
- [ ] Company dropdown loads and enables other filters
- [ ] Customer Group dropdown auto-loads when company selected
- [ ] Distribution Channel dropdown auto-loads when company selected
- [ ] Team dropdown auto-loads based on company + group + channel
- [ ] Salesperson dropdown auto-loads based on all selected filters
- [ ] Disabled state: child filters disabled until parent selected

### Testing
- [ ] Create test data: Company A with teams + salespersons
- [ ] Create test data: Company B with different teams + salespersons
- [ ] Select Company A → only show teams/salespersons from Company A
- [ ] Select Customer Group → further restrict options
- [ ] Select Distribution Channel → further restrict options
- [ ] Select Team → show only salespersons in that team
- [ ] Report data updates based on final selection

---

## Data Flow Example

**Setup:**
- Company: "BMH Middle East"
- Sales Team: "Damascus Branch" (company = BMH Middle East)
- Salesperson: "Abdelraheam Berkhayal" (company = BMH Middle East, team = Damascus Branch)

**User Flow:**
1. Open report
2. Filter step 1: Select Company = "BMH Middle East"
   - ✅ Customer Group dropdown shows only groups used by teams/salespersons in BMH ME
   - ✅ Distribution Channel dropdown shows only channels used by teams/salespersons in BMH ME
   - ✅ Team dropdown shows: Damascus Branch, + others in BMH ME
3. Filter step 2: Select Customer Group = "B2B"
   - ✅ Team dropdown now shows only teams in BMH ME with B2B assignment
   - ✅ Salesperson dropdown shows only salespersons in BMH ME with B2B assignment
4. Filter step 3: Select Distribution Channel = "Wholesale"
   - ✅ Team dropdown further restricted
   - ✅ Salesperson dropdown further restricted
5. Filter step 4: Select Team = "Damascus Branch"
   - ✅ Salesperson dropdown shows only salespersons in Damascus Branch
6. Filter step 5: Select Salesperson = "Abdelraheam Berkhayal"
   - ✅ Report shows data for this salesperson with all filters applied

---

## Notes

- **Cascading is smart:** Options at each level include only relevant items based on previous selections
- **No invalid combinations:** Cannot select a salesperson from a different company
- **Parent-child reset:** If user changes a filter, all dependent child filters are reset
- **Performance:** Index on company_id ensures fast filtering
- **Fallback logic:** If company_id is NULL (older data), queries still work but not restricted by company
- **Optional company:** Users can leave company_id NULL for profile that applies globally (rare case)

---

**Estimated effort:** 2-3 hours (schema, backend cascade endpoints, frontend cascading hooks, testing)  
**Priority:** High — completes organizational context for filtering  

