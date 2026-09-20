# Requirement: Exclude NULL Company Salespersons from Cascading Filters

**Status:** Filter refinement  
**Priority:** Medium  
**Type:** Data visibility/filtering behavior change  
**Date:** 2026-09-14  

---

## Problem

### Current Behavior (Undesired)

When a user selects a **Company** filter (e.g., "Company 1"), the system returns:
1. ✅ Salespersons explicitly assigned to Company 1
2. ❌ **ALSO** salespersons with NO company assignment (NULL company_key_override)

When a user selects a **Sales Team** filter, the system returns:
1. ✅ Salespersons in that team who are assigned to the selected company
2. ❌ **ALSO** salespersons in that team with NO company assignment

### Why This Is a Problem

**Business Context:**
- Legacy salespersons were imported without company assignment (NULL)
- Corporate management team members have no company (shared across all companies)
- These orphaned/legacy/corporate salespersons should NOT appear when filtering by a specific company

**User Experience Issue:**
- When admin filters by "Company 1", they see 50 salespersons:
  - 30 actually assigned to Company 1 ✓
  - 20 with no company assignment ✗ (confusing, not relevant)
- User cannot distinguish who actually works for Company 1 vs. who is unassigned/corporate

**Data Clarity Issue:**
- Filter dropdown shows unrelated salespersons, making it hard to find the right person
- Report results are confusing (includes data from corporate staff who aren't company-specific)

---

## Solution: Exclude NULL Company From Filters

### Change Requirement

When filtering by company in the cascading filter system:
- **Show ONLY** salespersons/teams explicitly assigned to the selected company
- **Hide** salespersons/teams with NULL company assignment
- Orphaned/legacy/corporate records become invisible in company-filtered views

### Which Filters Are Affected

**Salesperson dropdown:**
- Current: Shows "all salespersons in Company X" OR "salespersons with no company"
- New: Shows "only salespersons explicitly assigned to Company X"

**Sales Team dropdown:**
- Current: Shows "all teams in Company X" OR "teams with no company"
- New: Shows "only teams explicitly assigned to Company X"

**Downstream effect (Customer Group, Distribution Channel dropdowns):**
- These dropdowns show options based on which salespersons/teams are visible
- If NULL company salespersons are hidden, the options they use will be hidden too
- Result: cleaner, more relevant filter options

### When This Applies

This NULL-exclusion applies **only when a Company filter is selected**:

| Scenario | Behavior |
|----------|----------|
| No company filter selected | Show all salespersons (including NULL) |
| Company filter selected (e.g., "Company 1") | Show ONLY Company 1 salespersons (hide NULL) |
| Company filter selected + Team filter | Show ONLY salespersons in that team in that company (hide NULL) |
| Company filter selected + Group filter | Show ONLY salespersons with that group in that company (hide NULL) |

### When NULL Company Records Are Useful

**Use case:** Administrative override or corporate-level reporting
- Users might sometimes need to see all salespersons including unassigned ones
- **Future enhancement** (out of scope): Add checkbox "Include unassigned salespersons" in advanced filter options
- For now: When no company is selected, all records (including NULL) are visible

---

## Implementation Approach

### Backend Filter Endpoints

**Current logic (for each cascading filter endpoint):**
```
Returns salespersons WHERE:
  company_id = @selectedCompanyId 
  OR company_id IS NULL          ← This should be REMOVED
```

**New logic:**
```
Returns salespersons WHERE:
  company_id = @selectedCompanyId
  (No OR clause — strictly match selected company)
```

### Affected Endpoints

Four cascading filter endpoints need this change:

1. **`GET /filters/salespersons?companyId=X`**
   - Remove the "OR company_id IS NULL" condition
   - Result: Only show salespersons where company_id = X

2. **`GET /filters/teams?companyId=X`**
   - Remove the "OR company_id IS NULL" condition
   - Result: Only show teams where company_id = X

3. **`GET /filters/customer-groups?companyId=X`**
   - When computing which groups are "used", exclude NULL company salespersons/teams
   - A group is "used" only if assigned to someone in the selected company

4. **`GET /filters/distribution-channels?companyId=X`**
   - Same as customer-groups
   - A channel is "used" only if assigned to someone in the selected company

### No Change Needed

**These endpoints unchanged:**
- `GET /filters/companies` — shows all companies (unchanged)
- `GET /filters/customer-groups?companyId=null` or without companyId param — shows all groups (unchanged)
- `GET /filters/distribution-channels` (no company param) — shows all channels (unchanged)
- `GET /filters/salespersons` (no company param) — shows all salespersons including NULL (unchanged)

---

## Data Integrity Considerations

### Existing Data State

**Before change:**
- ~78 salespersons in system
- ~50 have company_key_override assigned
- ~28 have company_key_override = NULL (legacy/corporate)

**After change:**
- Database data is UNCHANGED (no migration needed)
- Only filter query logic changes
- NULL company salespersons remain in database, just hidden from company-filtered views

### Backward Compatibility

- Endpoints still accept all parameters (no breaking changes)
- Unassigned salespersons still exist in database, retrievable via other means
- Report data includes NULL company salespersons (no data loss)
- Only visibility in cascading filters changes

---

## User Experience Impact

### Before
1. User selects "Company 1" in filter
2. Salesperson dropdown loads: 30 from Company 1 + 20 unassigned = 50 total
3. User confused: "Why are these other people showing up?"

### After
1. User selects "Company 1" in filter
2. Salesperson dropdown loads: 30 from Company 1 only
3. User sees focused, relevant list

---

## Future Enhancement (Out of Scope)

**Optional future feature:** Advanced filter toggle
- Add checkbox "Include unassigned/corporate salespersons"
- When checked: show NULL company records alongside filtered results
- When unchecked (default): exclude NULL (current behavior after this change)
- Allows power users to include orphaned records when needed

---

## Verification Checklist

After implementation, verify:
- [ ] When company filter = NULL (not selected), all salespersons show (including NULL company ones)
- [ ] When company filter = "Company 1", show ONLY salespersons with company_id = 1 (no NULL)
- [ ] When company filter = "Company 2", show ONLY salespersons with company_id = 2 (no NULL)
- [ ] Team filter behaves the same way
- [ ] Customer group/channel dropdowns only show options used by selected company's salespersons
- [ ] Report still processes NULL company salespersons (data is not lost, just filtered from UI)
- [ ] Database is unchanged (only query behavior changed)

---

## Scope & Effort

**Scope:** Filter logic refinement (small change)  
**Effort:** 15-30 minutes (modify 4 endpoints, test with live data)  
**Risk:** Low (data not modified, only query conditions changed)  
**Rollback:** Trivial (revert query condition in < 1 minute)  

---

## Notes

- This change makes the system more intuitive: "Show me Company X's people" returns only Company X's people
- Orphaned/legacy records are not deleted, just hidden from company-filtered views
- Makes the naming clearer: "General B2B Manager" won't appear twice (once for Company 1 context, once unassigned)
- Foundation for future "include corporate resources" feature

