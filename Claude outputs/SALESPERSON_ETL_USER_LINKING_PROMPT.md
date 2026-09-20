# Salesperson ETL ↔ User Account Linking Architecture

**Feature:** Link ETL salespersons to user accounts with admin-managed profiles  
**Goal:** Create a three-layer relationship: ETL Data → User Account → Admin Annotations  
**Status:** Ready for design & implementation  

---

## The Data Model (Three-Layer Architecture)

### Layer 1: ETL Source (Immutable, Read-Only)
```
Dim_Salesperson (from ODOO via ETL, fully replaced on refresh)
├── SalespersonKey (PK)
├── SalespersonName (ODOO name: "AbdNasser AlKhair")
├── CompanyKey
├── IsActive
└── [other ODOO fields]
```

### Layer 2: User Account (System Identity)
```
app_user (new field added)
├── user_id (PK)
├── email
├── role (e.g., "Salesperson", "Admin", "Manager")
├── salesperson_key (FK → Dim_Salesperson) ← NEW
├── is_active
└── [auth fields]
```

**Why this column?** When a user with role="Salesperson" logs in, this foreign key links them to their profile in the admin annotation layer.

### Layer 3: Admin Annotations (Reference/Override Layer)
```
salesperson_admin_profile (existing overlay table)
├── salesperson_key (PK, FK → Dim_Salesperson)
├── admin_name_override (e.g., "Abd Nasser Khair" - cleaner than ODOO name)
├── team_key_override (Sales Team assignment)
├── segment_key_override (Customer Group)
├── channel_key_override (Distribution Channel)
├── target_override_amount (Sales Target)
└── [history/audit fields]
```

**Why separate?** This survives ETL refreshes. ODOO names stay in Dim_Salesperson; admin cleans them up here.

---

## User Creation & Salesperson Linking

### New User Creation Flow

**Updated User Form** (in `/admin/users` or `/admin/create-user`):

When **Role = "Salesperson"**:
```
Role: [Dropdown: Admin | Manager | Salesperson | GCCO | B2B Director]
       (on select "Salesperson" → show next field)

Salesperson: [Dropdown: ALL ETL salespersons, inactive ones greyed out]
  └── Options loaded from: SELECT salesperson_key, salesperson_name, is_active 
                           FROM Dim_Salesperson 
                           ORDER BY is_active DESC, salesperson_name ASC
  └── Display format: "ODOO Name [Code]" or "ODOO Name [Team]"
       Example: "AbdNasser AlKhair [Tripoli Road]"
  └── Validation: Must be active OR confirm override if inactive

Email: [Text input]
Password: [Text input]
```

**On Save:**
```
INSERT INTO app_user (email, role, salesperson_key, password_hash, is_active)
VALUES (?, 'Salesperson', ?, ?, 1)
```

### Existing User Editing

If user role = "Salesperson", show:
```
Current Salesperson: [Dropdown with current selection highlighted]
Change To: [New salesperson selection]
```

Changing the `salesperson_key` reassigns the user to a different admin profile.

---

## Salesperson Admin Page Updates

### Table Enhancement (Sales Person Admin)

Add new columns + interaction:

| Column | Type | Source | Editable | Notes |
|--------|------|--------|----------|-------|
| **ODOO Name** | Text | `Dim_Salesperson.SalespersonName` | No | Read-only, from ETL |
| **Admin Name** | Text | `salesperson_admin_profile.admin_name_override` | Yes | Cleaner display name |
| **Team** | Dropdown | `salesperson_admin_profile.team_key_override` | Yes | Which sales team |
| **Customer Group** | Dropdown | `salesperson_admin_profile.segment_key_override` | Yes | B2B/B2C/Back Office/etc |
| **Distribution** | Dropdown | `salesperson_admin_profile.channel_key_override` | Yes | Retail/Projects/Wholesale |
| **Target** | Currency | `salesperson_admin_profile.target_override_amount` | Yes | Sales target |
| **Linked User** | Link/Badge | `app_user.email` | No | Shows email of user linked to this salesperson |
| **Status** | Badge | `Dim_Salesperson.is_active` | No | Active / Inactive (from ODOO) |
| **Actions** | Buttons | — | — | Edit / Link User (if no user) / View History |

### Key Interaction: "Link User" Button

If a salesperson has no linked user:
```
[Row: AbdNasser AlKhair | Abd Nasser | Tripoli | B2C | Retail | $100,000 | — | Active]
                                                                         ↑
                                                                   [Link User] button appears
```

Click → Inline dialog:
```
Link User to "Abd Nasser Khair"
┌─────────────────────────────────────┐
│ Select existing user or create new: │
│                                     │
│ [ Search by email... ]              │
│ ☐ Create new user for this          │
│   └─ Email: [text]                  │
│   └─ Password: [text]               │
│                                     │
│ [Cancel] [Save]                     │
└─────────────────────────────────────┘
```

**On Save:**
- If existing user selected: UPDATE `app_user` SET `salesperson_key = ?` WHERE `user_id = ?`
- If new user: INSERT into `app_user` + set role to "Salesperson" + set `salesperson_key`

---

## Database Changes

### Migration: Add Salesperson Link to Users

**File:** `data/warehouse/migrations/0017_user_salesperson_linking.sql`

```sql
-- Add foreign key to app_user linking to ETL salesperson
ALTER TABLE app_user
ADD COLUMN salesperson_key BIGINT NULL,
ADD FOREIGN KEY (salesperson_key) REFERENCES Dim_Salesperson(SalespersonKey);

-- Add unique constraint: only one user per salesperson (optional, if you want 1:1)
-- ALTER TABLE app_user ADD UNIQUE KEY uk_user_salesperson (salesperson_key WHERE salesperson_key IS NOT NULL);
-- Omit if you want multiple users per salesperson (team leads, etc.)

-- Extend admin profile to include admin-friendly name override
ALTER TABLE salesperson_admin_profile
ADD COLUMN admin_name_override VARCHAR(255) NULL
AFTER salesperson_key;

-- Add index for fast lookup when user logs in
CREATE INDEX idx_app_user_salesperson_key ON app_user(salesperson_key);
```

### Audit/History for User-Salesperson Changes

**File:** Same migration

```sql
CREATE TABLE IF NOT EXISTS user_salesperson_change_history (
    history_id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id            INT NOT NULL,
    old_salesperson_key BIGINT NULL,
    new_salesperson_key BIGINT NULL,
    changed_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    changed_by         INT NULL,
    reason             VARCHAR(500) NULL,
    FOREIGN KEY (user_id) REFERENCES app_user(user_id),
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_user (user_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## Backend Services

### User Service Enhancement

**File:** `backend/src/services/userService.ts`

Add method:
```typescript
async linkUserToSalesperson(
  userId: number,
  salespersonKey: number | null,
  actorUserId: number
): Promise<void> {
  // Validate salesperson exists
  if (salespersonKey) {
    const [check] = await pool.query(
      'SELECT 1 FROM Dim_Salesperson WHERE salesperson_key = ? LIMIT 1',
      [salespersonKey]
    );
    if (!(check as any).length) {
      throw new ValidationError('Salesperson not found');
    }
  }

  // Get old value for history
  const [user] = await pool.query(
    'SELECT salesperson_key FROM app_user WHERE user_id = ? LIMIT 1',
    [userId]
  );
  const oldKey = (user as any)[0]?.salesperson_key || null;

  // Update user
  await pool.query(
    'UPDATE app_user SET salesperson_key = ? WHERE user_id = ?',
    [salespersonKey, userId]
  );

  // Log to history
  await pool.query(
    `INSERT INTO user_salesperson_change_history 
     (user_id, old_salesperson_key, new_salesperson_key, changed_by) 
     VALUES (?, ?, ?, ?)`,
    [userId, oldKey, salespersonKey, actorUserId]
  );
}

async getSalespersonDropdownOptions(): Promise<Array<{salesperson_key: number; salesperson_name: string; is_active: boolean; sales_team_name?: string}>> {
  const query = `
    SELECT 
      sp.salesperson_key,
      sp.salesperson_name,
      sp.is_active,
      st.sales_team_name
    FROM Dim_Salesperson sp
    LEFT JOIN Dim_SalesTeam st ON sp.sales_team_key = st.sales_team_key
    ORDER BY sp.is_active DESC, sp.salesperson_name ASC
  `;
  const [rows] = await pool.query(query);
  return rows as any;
}
```

### Salesperson Admin Service Enhancement

**File:** `backend/src/services/salespersonAdminService.ts`

Update query to include linked user:

```typescript
async listSalespersons(...) {
  const query = `
    SELECT
      sp.salesperson_key,
      sp.salesperson_name as odoo_name,
      sap.admin_name_override,
      sap.team_key_override,
      st.sales_team_name,
      sap.segment_key_override,
      ds.segment_name,
      sap.channel_key_override,
      dc.distribution_channel_name,
      sap.target_override_amount,
      sp.is_active,
      au.email as linked_user_email,  -- NEW
      sap.updated_at,
      u.email as updated_by_email
    FROM Dim_Salesperson sp
    LEFT JOIN salesperson_admin_profile sap ON sp.salesperson_key = sap.salesperson_key
    LEFT JOIN Dim_SalesTeam st ON sap.team_key_override = st.sales_team_key
    LEFT JOIN Dim_Segment ds ON sap.segment_key_override = ds.segment_key
    LEFT JOIN Dim_DistributionChannel dc ON sap.channel_key_override = dc.channel_key
    LEFT JOIN app_user au ON sp.salesperson_key = au.salesperson_key  -- NEW
    LEFT JOIN app_user u ON sap.updated_by = u.user_id
    WHERE sp.is_active = 1 OR sap.salesperson_key IS NOT NULL
    ORDER BY sp.salesperson_name ASC
  `;
  // ... execute and return
}
```

---

## Backend Routes

### User Routes Enhancement

**File:** `backend/src/routes/admin/users.ts`

Add endpoint for salesperson dropdown:
```typescript
router.get(
  '/admin/users/salesperson-options',
  requireAuth,
  requirePasswordChangeCleared,
  async (req, res, next) => {
    try {
      const options = await userService.getSalespersonDropdownOptions();
      res.json({ options });
    } catch (err) {
      next(err);
    }
  }
);
```

Update user creation to accept `salesperson_key`:
```typescript
// In POST /admin/users
const { email, role, password, salesperson_key } = req.body;

if (role === 'Salesperson' && !salesperson_key) {
  return res.status(400).json({ error: 'Salesperson required for Salesperson role' });
}

// Validate salesperson exists
if (salesperson_key) {
  const [check] = await pool.query(
    'SELECT 1 FROM Dim_Salesperson WHERE salesperson_key = ?',
    [salesperson_key]
  );
  if (!(check as any).length) {
    return res.status(400).json({ error: 'Salesperson not found' });
  }
}

// Insert user with salesperson_key
await pool.query(
  `INSERT INTO app_user (email, role, password_hash, salesperson_key, is_active)
   VALUES (?, ?, ?, ?, 1)`,
  [email, role, hashedPassword, salesperson_key || null]
);
```

Add endpoint to link existing user:
```typescript
router.patch(
  '/admin/users/:userId/salesperson',
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_users', 'edit'),
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { salesperson_key } = req.body;
      const actorUserId = req.user?.id;

      await userService.linkUserToSalesperson(userId, salesperson_key, actorUserId);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);
```

---

## Frontend Updates

### 1. User Creation/Edit Page

**File:** `frontend/src/app/admin/users/page.tsx` (update existing)

Add conditional field for salesperson role:

```typescript
const [formData, setFormData] = useState({
  email: '',
  role: '',
  salesperson_key: '',
  password: '',
});

const [salespersonOptions, setSalespersonOptions] = useState([]);

useEffect(() => {
  if (formData.role === 'Salesperson') {
    loadSalespersonOptions();
  }
}, [formData.role]);

const loadSalespersonOptions = async () => {
  try {
    const res = await fetch('/admin/users/salesperson-options');
    const data = await res.json();
    setSalespersonOptions(data.options || []);
  } catch (err) {
    console.error('Failed to load salesperson options:', err);
  }
};

// In render:
<div>
  <label>Role *</label>
  <Select
    options={['Admin', 'Manager', 'Salesperson', 'GCCO', 'B2B Director']}
    value={formData.role}
    onChange={(e) => setFormData({ ...formData, role: e.target.value })}
  />
</div>

{formData.role === 'Salesperson' && (
  <div>
    <label>Salesperson *</label>
    <Select
      options={salespersonOptions.map(sp => ({
        value: sp.salesperson_key,
        label: `${sp.salesperson_name} [${sp.sales_team_name || 'N/A'}]`
      }))}
      value={formData.salesperson_key}
      onChange={(e) => setFormData({ ...formData, salesperson_key: e.target.value })}
    />
  </div>
)}
```

### 2. Salesperson Admin Page

**File:** `frontend/src/app/admin/salespersons/page.tsx` (update existing)

Add columns:
```typescript
const columns = [
  { accessorKey: 'salesperson_name', header: 'ODOO Name' },
  { accessorKey: 'admin_name_override', header: 'Admin Name', cell: (info) => (
    <EditableCell value={info.getValue()} onSave={(val) => updateField(info.row.original.salesperson_key, 'admin_name_override', val)} />
  )},
  { accessorKey: 'sales_team_name', header: 'Team' },
  { accessorKey: 'segment_name', header: 'Customer Group' },
  { accessorKey: 'distribution_channel_name', header: 'Distribution' },
  { accessorKey: 'target_override_amount', header: 'Target', cell: (info) => (
    <EditableCell type="number" value={info.getValue()} onSave={(val) => updateField(...)} />
  )},
  {
    id: 'linked_user',
    header: 'Linked User',
    cell: (info) => (
      info.row.original.linked_user_email ? 
        <span title={info.row.original.linked_user_email}>{info.row.original.linked_user_email}</span>
        : <button onClick={() => openLinkUserModal(info.row.original)}>Link User</button>
    )
  },
  { accessorKey: 'is_active', header: 'Status', cell: (info) => info.getValue() ? '✓ Active' : '✗ Inactive' },
];
```

---

## Data Consistency Rules

### When Salesperson Status Changes (in ETL)

**If salesperson becomes inactive:**
- User linked to that salesperson should also become inactive (optional — implement as config)
- OR: User stays active but sees warning when they log in ("Your salesperson profile is inactive")
- OR: User can still work, but with read-only access

**Rule to enforce:** If `is_active = 0` in `Dim_Salesperson`, don't allow new user links to that salesperson (but existing users keep their link for history).

### When User is Deleted

Keep the `user_salesperson_change_history` for audit trail, even if user is deleted.

---

## Login Flow Integration

When a **salesperson user logs in:**

```typescript
// In authentication middleware
const user = await userService.getUserWithSalesperson(userId);

if (user.role === 'Salesperson') {
  // Load salesperson profile
  const profile = await salespersonAdminService.getSalespersonProfile(user.salesperson_key);
  
  // Store in session/JWT
  session.set('salesperson_key', user.salesperson_key);
  session.set('sales_team_key', profile.team_key_override);
  session.set('segment_key', profile.segment_key_override);
  session.set('channel_key', profile.channel_key_override);
}
```

Then in dashboards, filter by `session.salesperson_key` or `session.segment_key` depending on role.

---

## Summary of Changes

| Component | Action | Why |
|-----------|--------|-----|
| `app_user` table | ADD `salesperson_key` FK | Link user to ETL salesperson |
| `salesperson_admin_profile` | ADD `admin_name_override` | Store admin-friendly names |
| New migration `0017` | Create + seed | Set up relationships, audit table |
| User service | Add `linkUserToSalesperson()` | Manage user-salesperson links |
| Salesperson service | Update list query | Include linked user email |
| User routes | Add dropdown endpoint + patch for linking | Support UI dropdowns |
| User admin page | Add role-conditional salesperson field | Allow selection on create/edit |
| Salesperson admin page | Add linked user column + link button | Show and manage relationships |
| Auth middleware | Load salesperson profile on login | Populate session with profile data |

---

## Success Criteria

✅ User creation with role="Salesperson" requires selecting from ETL salesperson dropdown  
✅ Salesperson admin page shows ODOO name (read-only) + Admin Name (editable)  
✅ Salesperson admin page shows linked user email or "Link User" button  
✅ Clicking "Link User" opens modal to create or select existing user  
✅ User login loads salesperson profile (Team, CG, DC, Target) into session  
✅ Changing salesperson key logs to history  
✅ Inactive salespersons cannot be selected for new users (but existing links persist)  
✅ History survives when salesperson status changes  
✅ All 3 layers (ETL ↔ User ↔ Admin) are in sync and auditable  

---

**Ready to implement:** This describes the complete three-layer relationship. No conflicts with ETL design. All changes are backward-compatible (existing salespersons without users just show "Link User" button).
