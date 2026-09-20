# Requirements: Company Field & Dynamic Cascading Filters

**Status:** Enhancement specification  
**Priority:** High  
**Type:** Feature requirement  

---

## Problem Statement

### Current State Issues

**Admin Profile Pages (Salesperson & Sales Team):**
- Admins can edit salesperson details: name, assigned team, customer group, distribution channel, target
- Admins can edit sales team details: team name, code, customer group, target
- **Missing:** No organizational context — which company does each person/team belong to?
- Result: Cannot distinguish between salespersons/teams from different companies (e.g., BMH Egypt vs BMH Middle East)

**Report Filtering:**
- Users can select from independent dropdowns: Company, Customer Group, Distribution Channel, Branch (Sales Team), Salesperson
- These dropdowns are **not connected** — selecting Company does NOT restrict what appears in other dropdowns
- Result: Users can create invalid filter combinations (e.g., select "Company A" but then select a "Salesperson from Company B")
- Users get confusing, irrelevant options in dropdowns because there's no context-aware filtering

**Business Impact:**
- Admin cannot track which salesperson belongs to which company
- Reports show misleading data because filters allow invalid combinations
- User experience is poor because filter dropdowns contain unrelated options

---

## What We Need to Implement

### 1. Database Schema Enhancement

**Requirement:** Add organizational context to admin profiles

#### **Salesperson Admin Profile**
- Add a field that links each salesperson to a company
- This field should be:
  - Optional (for backward compatibility with existing data)
  - Nullable (allowing profiles without company assignment)
  - Editable by admins
  - Tracked in history table for audit trail
- When admin edits a salesperson, they should see and be able to set this company field

#### **Sales Team Admin Profile**
- Add a field that links each sales team to a company
- Same characteristics as salesperson company field:
  - Optional, nullable, editable, audited
- When admin edits a sales team, they should see and be able to set this company field

**Impact:** This allows the system to know "Salesperson X works for Company A" and "Team Y belongs to Company B"

---

### 2. Admin Pages (Salesperson & Sales Team Management)

**Requirement:** Allow admins to assign company to each profile

#### **Salesperson Admin Page**
- Show company information in the table listing all salespersons
- In the edit form/panel, add a dropdown to select which company this salesperson belongs to
- The dropdown should show all available companies from the admin company reference data
- When saving changes, persist the selected company

#### **Sales Team Admin Page**
- Same as salesperson page:
  - Show company in table listing
  - Add company dropdown to edit form
  - Save company selection when editing

**UX Consideration:** Make it clear which company each person/team is assigned to so admins can see at a glance

---

### 3. Dynamic Filter Architecture (Reports)

**Requirement:** Filters should respond intelligently to each other based on company context

#### **Filter Cascade Order (Top to Bottom)**
```
1. COMPANY (Master filter — selections here affect everything below)
   ↓
2. CUSTOMER GROUP (Narrows to groups used by selected company)
   ↓
3. DISTRIBUTION CHANNEL (Narrows to channels used by selected company)
   ↓
4. BRANCH / SALES TEAM (Narrows to teams in selected company, with group/channel refinement)
   ↓
5. SALESPERSON (Narrows to people in selected company/team, with group/channel refinement)
```

#### **Filter Behavior Rules**

**Stage 1: No filters selected**
- All dropdowns show all available options (from reference data)
- User clicks on Company dropdown first

**Stage 2: Company selected (e.g., "BMH Middle East")**
- Company dropdown now shows "BMH Middle East" as selected
- Other dropdowns below become **enabled** (were greyed out before)
- Customer Group dropdown: Show ONLY customer groups that are used by any team or salesperson in BMH ME
  - If a customer group is defined but no one in BMH ME uses it, don't show it
  - Only show groups that are actually relevant to this company
- Distribution Channel dropdown: Show ONLY channels used by teams/salespersons in BMH ME
- Branch/Team dropdown: Show ONLY teams assigned to BMH ME
- Salesperson dropdown: Show ONLY salespersons assigned to BMH ME

**Stage 3: Company + Customer Group selected**
- All above selections stay locked
- Distribution Channel dropdown: Now show only channels that are used by teams/salespersons in BMH ME that handle the selected customer group
  - Further narrows based on company + group combination
- Branch/Team dropdown: Show only teams in BMH ME that handle this customer group
- Salesperson dropdown: Show only salespersons in BMH ME with this customer group assignment

**Stage 4: Company + Customer Group + Distribution Channel selected**
- All above selections stay locked
- Branch/Team dropdown: Show only teams in BMH ME that handle both the selected group AND channel
- Salesperson dropdown: Show only salespersons in BMH ME with both group AND channel assignments

**Stage 5: Company + Customer Group + Distribution Channel + Branch selected**
- All above selections stay locked
- Salesperson dropdown: Show ONLY salespersons who are members of the selected branch/team

**Stage 6: All filters selected**
- Report shows data filtered by all selected criteria
- Cannot select invalid combinations (system prevents it automatically)

#### **Key Behaviors**
- **Reset dependent filters:** If user changes a higher-level filter (e.g., switches from Company A to Company B), all lower filters should reset automatically
  - This prevents stale selections from the previous company
- **Smart filtering:** Dropdowns should only show relevant options — no empty/invalid combinations
- **Disabled state:** Child filters should be disabled (greyed out) if their parent filter is not yet selected
- **Performance:** Smart filtering should work fast even with thousands of transactions

---

### 4. Backend Infrastructure

**Requirement:** Build API endpoints that support smart filtering

#### **What the Backend Needs to Support**

**Endpoint: Filter Dropdowns (Dynamic Options)**
- The system needs ways to query "what options are available given these selected filters?"
- For example:
  - "What customer groups exist for Company X?" → Query admin data filtered by company
  - "What teams exist in Company X that handle Customer Group Y?" → Query intersecting records
  - "What salespersons are in Team Z?" → Query salesperson profiles by team + company

**Endpoint: Data Retrieval with Hierarchy**
- When returning filter options, include enough information for the UI to know relationships
- Example: When loading teams dropdown, ensure we know which company each team belongs to

**Endpoint: Validation**
- Before executing a report, validate that all selected filters are compatible
- Don't allow report execution if user somehow selected filters from different companies

---

### 5. Frontend Filter UI (Reports)

**Requirement:** Implement cascading filter interface

#### **Visual & Interaction Design**

**Layout:**
- Five dropdowns displayed in order (Company → Customer Group → Distribution Channel → Branch → Salesperson)
- Each dropdown should be clearly labeled
- Show a visual indicator if dropdown is disabled (waiting for parent filter)

**Behavior:**
- When user selects Company:
  - Other dropdowns automatically populate with relevant options
  - Other dropdowns become enabled (clickable)
- When user changes any selection:
  - Lower-level dropdowns reset (clear their selection)
  - Lower-level dropdowns auto-populate with new relevant options
- Dropdowns stay synchronized with backend (always showing correct options for current selections)

**Error Prevention:**
- If user tries to select an invalid combination, show them available options only
- No way to create "broken" filter combinations

---

### 6. Data Integrity & Auditing

**Requirement:** Track all changes to company assignments

#### **Audit Trail**
- When admin assigns/changes a company for a salesperson or team, record it in history table
- History should show: who made the change, when, what was the old value, what is the new value
- This allows tracking why a profile changed if needed

#### **Data Consistency**
- When querying for salespersons in Company X, include both:
  - Salespersons explicitly assigned to Company X
  - Salespersons with NULL company (for backward compatibility with legacy data)
- Same for teams

---

## Implementation Approach

### Phase 1: Data Model (Database)
- Extend two tables with company link
- Create/update history tables
- Create indices for fast filtering

### Phase 2: Admin Interface (Backend + Frontend)
- Add company field to salesperson admin service
- Add company field to sales team admin service
- Update admin pages to show and edit company field
- Ensure validation (company must exist)

### Phase 3: Smart Filter Endpoints (Backend)
- Create API endpoints that return filtered options based on current selections
- Implement logic: "Given Company X and Customer Group Y, what teams are available?"
- Implement validation: "Are these filter selections valid together?"

### Phase 4: Cascading UI (Frontend)
- Implement cascading state management (when one filter changes, dependents update)
- Build hook/component that manages the cascade logic
- Update report filter UI to use cascading behavior
- Add enable/disable logic to dropdowns

### Phase 5: Integration & Testing
- Ensure admin changes propagate to filter options
- Test invalid combinations are prevented
- Test reset behavior when filters change
- Test performance with realistic data volume

---

## Key Design Decisions

### Company Assignment Model
- Company link is **optional** (allows existing data without company)
- Company link is **nullable** (explicitly allows "no company assignment")
- Company link is **not cascading delete** — if company is deleted, profiles remain (with NULL company)
- This design provides flexibility and backward compatibility

### Filter Smart Logic
- Smart filtering happens on **every keystroke/selection** — real-time updates
- Options are filtered at **query time** (not pre-computed) — ensures consistency
- Filtering logic is **server-side** (not frontend only) — prevents invalid requests to report API

### Performance Considerations
- Company field gets an index (fast company-based filtering)
- Smart filter endpoints should use indexed queries (fast option population)
- Reports should be fast because they filter on company_id which is indexed

---

## Success Criteria

### Functional Requirements
- ✅ Admins can assign company to each salesperson profile
- ✅ Admins can assign company to each sales team profile
- ✅ Admin changes are visible immediately in profile table
- ✅ Company assignment is tracked in audit history

### Filter Requirements
- ✅ When user selects Company, other dropdowns restrict options to that company
- ✅ When user selects Customer Group, Team/Salesperson dropdowns further restrict
- ✅ When user selects Distribution Channel, Team/Salesperson dropdowns further restrict
- ✅ When user selects Team, Salesperson dropdown shows only members of that team
- ✅ Changing a filter automatically resets dependent filters
- ✅ Disabled dropdowns prevent selection until parent is set
- ✅ No way to create invalid filter combinations

### Data Integrity
- ✅ All company assignments audited in history tables
- ✅ Invalid company IDs rejected on save
- ✅ Queries work correctly for both assigned and NULL companies

### Performance
- ✅ Filter dropdown loads in < 500ms even with 1000+ records
- ✅ Report executes in same time as before (company filter adds negligible overhead)

---

## Business Rules

### When Company Assignment Matters
- Filtering reports by company
- Preventing cross-company filter combinations
- Organizational hierarchy (knowing which team/person belongs to which company)
- Compliance/auditing (ensuring data stays within company boundaries)

### When Company is Optional
- Legacy/unassigned profiles can still work (they're not company-restricted)
- Global salespersons could technically have NULL company (though rare)
- Reports still run even if some profiles lack company assignment

---

## Out of Scope (Future Enhancements)
- Company-level role permissions (e.g., "Manager can only see their company's data")
- Company-level data isolation (data warehouse-level separation)
- Company-based data export restrictions
- These can be added later as separate features

---

## Deliverables Needed from Development Team

1. **Database Migration**: Add company_id columns and indices
2. **Backend Services**: Update salesperson/team services to handle company_id CRUD
3. **Backend Endpoints**: Create 4-5 smart filter endpoints (dynamic options based on selections)
4. **Frontend Components**: Update admin pages to show/edit company field
5. **Frontend Hook**: Implement cascading filter logic (state management for dependent filters)
6. **Frontend UI**: Update report filter section to use cascading dropdowns
7. **Testing**: Verify all filter combinations and edge cases
8. **Documentation**: Document new API endpoints and filter behavior

---

## Timeline Estimate

| Phase | Deliverable | Estimated Effort |
|-------|-------------|------------------|
| 1 | Database schema + migration | 30 min |
| 2 | Admin page updates (backend + frontend) | 1 hour |
| 3 | Smart filter endpoints | 1.5 hours |
| 4 | Cascading UI implementation | 1.5 hours |
| 5 | Integration + testing | 1 hour |
| **Total** | | **5.5 hours** |

---

## Notes

- This feature closes a critical gap: the system now understands company hierarchy
- Cascading filters improve UX by preventing invalid combinations
- Smart filtering ensures reports always show relevant data
- Foundation for future company-level permissions and data isolation features
- Backward compatible: existing data without company assignment continues to work

