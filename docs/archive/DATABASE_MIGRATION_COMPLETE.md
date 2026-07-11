# MySQL Database Migration to powerBI_Data - Complete ✅

## Executive Summary

Successfully migrated the dashboard backend from `ps_warehouse` database to the live `powerBI_Data` MySQL database. All backend SQL queries have been updated to use the correct table and column names from the powerBI_Data schema.

---

## Changes Made

### 1. Environment Configuration

**File:** `backend/.env`
- Updated `DB_NAME` from `ps_warehouse` to `powerBI_Data`
- All other database credentials remain configured:
  - DB_HOST: localhost
  - DB_PORT: 3306
  - DB_USER: powerbi_user
  - DB_PASSWORD: [REDACTED-rotate-this-password]

### 2. SQL Query Updates

#### A. Table Name Mappings

| Old Table Name | New Table Name | Reason |
|---|---|---|
| `fact_order` | `Fact_Orders` | Case-sensitive schema naming |
| `fact_target_plan` | `Fact_Targets` | Case-sensitive schema naming |
| `dim_date` | `Dim_Date` | Case-sensitive schema naming |
| `dim_salesperson` | `Dim_Salesperson` | Case-sensitive schema naming |
| `dim_sales_team` | `Dim_SalesTeam` | Case-sensitive schema naming |
| `dim_segment` | `Dim_Segment` | Case-sensitive schema naming |
| `dim_company` | `Dim_Company` | Case-sensitive schema naming |
| `dim_distribution_channel` | `Dim_DistributionChannel` | Case-sensitive schema naming |

#### B. Column Name Mappings

| Old Column Name | New Column Name | Table(s) |
|---|---|---|
| `order_value` | `OrderValue` | Fact_Orders |
| `order_volume` | `OrderVolume` | Fact_Orders |
| `order_datetime` | `OrderDateTime` | Fact_Orders |
| `calendar_date` | `Date` | Dim_Date |
| `date_key` | `DateKey` | All tables |
| `target_year` | `Year` | Fact_Targets |
| `target_month` | `Month` | Fact_Targets |
| `target_revenue` | `Target_Revenue` | Fact_Targets |
| `target_volume` | `Target_Volume` | Fact_Targets |
| `salesperson_name` | `salesperson` | Dim_Salesperson |
| `salesperson_key` | `SalespersonKey` | All tables |
| `sales_team_name` | `SalesTeam` | Dim_SalesTeam |
| `sales_team_key` | `SalesTeamKey` | All tables |
| `company_name` | `Company` | Dim_Company |
| `company_key` | `CompanyKey` | All tables |
| `channel_name` | `DistributionChannel` | Dim_DistributionChannel |
| `channel_key` | `ChannelKey` | All tables |
| `segment_name` | `Segment` | Dim_Segment |
| `segment_key` | `SegmentKey` | All tables |

### 3. Files Modified

#### Backend Measures & Routes

1. **`backend/src/measures/tachometer.ts`**
   - ✅ Updated `fetchValueVolume()` - now queries Fact_Orders with OrderValue/OrderVolume
   - ✅ Updated `fetchTargetForMonths()` - now queries Fact_Targets with Year/Month/Target_Revenue/Target_Volume
   - ✅ Updated `fetchValueVolumeGrouped()` - for breakdown queries by dimension
   - ✅ Updated `fetchTargetForMonthsGrouped()` - for grouped target queries
   - ✅ Updated `GROUP_CONFIG` - uses new table names and column names
   - ✅ Updated module docstring - reflects new table/column names

2. **`backend/src/measures/filters.ts`**
   - ✅ Updated `FILTER_COLUMNS` - uses PascalCase column names (CompanyKey, SegmentKey, etc.)
   - ✅ Updated module docstring - reflects new Dim_* table names

3. **`backend/src/measures/refreshStatus.ts`**
   - ✅ Updated `fetchLastUpdate()` - queries Fact_Orders.OrderDateTime
   - ✅ Added error handling for pipeline_run_log fallback
   - ✅ Updated module docstring - reflects new table names

4. **`backend/src/routes/filters.ts`**
   - ✅ Updated `/business-units` endpoint - queries Dim_Company with column aliasing
   - ✅ Updated `/customer-groups` endpoint - queries Dim_Segment with column aliasing
   - ✅ Updated `/distribution-channels` endpoint - queries Dim_DistributionChannel
   - ✅ Updated `/branches` endpoint - queries Dim_SalesTeam with SalesCity
   - ✅ Updated `/salespersons` endpoint - queries Dim_Salesperson
   - ✅ All queries use aliases to maintain API contract (e.g., CompanyKey AS company_key)
   - ✅ Updated module docstring - reflects new table names

5. **`backend/src/middleware/scopeContext.ts`**
   - ✅ Updated docstring - references Dim_Salesperson.SalespersonKey

---

## Data Source Integration

### Database Schema

The powerBI_Data database contains the following key tables for the dashboard:

#### Fact Tables
- **Fact_Orders** - Main sales order data
  - Columns: OrderValue, OrderVolume, DateKey, OrderDateTime
  - Keys: CompanyKey, SegmentKey, ChannelKey, SalesTeamKey, SalespersonKey

- **Fact_Targets** - Sales targets by month
  - Columns: Target_Revenue, Target_Volume, Year, Month
  - Keys: CompanyKey, SegmentKey, ChannelKey, SalesTeamKey, SalespersonKey

#### Dimension Tables
- **Dim_Date** - Calendar dimension
  - Columns: Date, DateKey, Year, Month, MonthName, YearMonth, Quarter, etc.

- **Dim_Company** - Company/Business Unit
  - Columns: CompanyKey, Company

- **Dim_Segment** - Customer Group/Segment
  - Columns: SegmentKey, Segment

- **Dim_DistributionChannel** - Distribution channels
  - Columns: ChannelKey, DistributionChannel

- **Dim_SalesTeam** - Sales branch/team
  - Columns: SalesTeamKey, SalesTeam, SalesCity, SalesSegment, SalesTeamCompany

- **Dim_Salesperson** - Individual salespeople
  - Columns: SalespersonKey, salesperson, SalesTeamKey, DistributionChannel

---

## API Contract Maintained

All filter endpoints maintain backward compatibility through column aliasing:

```typescript
// Example: /filters/business-units returns
[
  { company_key: 1, company_name: "Majaal" },
  { company_key: 2, company_name: "Tika" }
]
// Even though database column is named "Company", not "company_name"
```

This ensures the frontend receives the expected data structure without changes.

---

## Verification Checklist

### Pre-Deployment
- ✅ Database connection string updated in `.env`
- ✅ All SQL queries updated with new table names
- ✅ All column names updated to match powerBI_Data schema
- ✅ Column aliases added to maintain API contract
- ✅ Error handling added for missing tables (pipeline_run_log)
- ✅ Module docstrings updated for maintainability
- ✅ No hardcoded old table names remain in code

### Testing Checklist (To Be Performed)
- [ ] Backend starts without errors
- [ ] Database connection successful
- [ ] GET /api/filters/business-units returns company data
- [ ] GET /api/filters/customer-groups returns segment data
- [ ] GET /api/filters/distribution-channels returns channel data
- [ ] GET /api/filters/branches returns sales team data
- [ ] GET /api/filters/salespersons returns salesperson data
- [ ] GET /api/tachometer/overview returns KPI cards with correct values
- [ ] GET /api/tachometer/breakdown returns breakdown data by dimension
- [ ] GET /api/tachometer/trend returns monthly series data
- [ ] GET /api/meta/refresh-status returns status information
- [ ] Dashboard filters work correctly
- [ ] Dashboard gauges and charts display data
- [ ] PDF exports include filtered data

---

## Deployment Instructions

### 1. Install Backend Dependencies
```bash
cd 07ps-sales-dashboard-app/backend
npm install
```

### 2. Update Environment
- Ensure `.env` file has:
  - DB_NAME=powerBI_Data
  - DB_HOST=localhost
  - DB_PORT=3306
  - DB_USER=powerbi_user
  - DB_PASSWORD=[REDACTED-rotate-this-password]

### 3. Start Backend Server
```bash
npm start
# Backend should be available at http://localhost:4000
```

### 4. Verify Database Connection
```bash
# Check if filter endpoints return data
curl http://localhost:4000/api/filters/business-units
# Should return JSON array of companies
```

### 5. Test Frontend Integration
- Start frontend development server
- Verify filters populate with data
- Test dashboard calculations match expected values
- Verify data is current (matches live database)

---

## Known Issues & Limitations

### pipeline_run_log Table
- The `pipeline_run_log` table is not present in powerBI_Data
- Workaround: Error handling added to return `null` for lastRefreshTime when table is missing
- Impact: "Last Refresh Time" will not display on the dashboard until this table is added
- Resolution: Either add the table to the ETL pipeline, or modify the refresh status logic

### Column Name Case Sensitivity
- MySQL behavior varies by OS filesystem:
  - **Linux/Mac**: Fully case-sensitive (requires exact case match)
  - **Windows**: Case-insensitive table names, case-sensitive column names
- Current implementation uses exact case as in the schema for maximum compatibility

---

## Rollback Procedure

If issues arise, revert to the old database:

1. Edit `backend/.env`:
   ```
   DB_NAME=ps_warehouse
   ```

2. Restart backend server

3. Current code will attempt to use old table names - **NOT RECOMMENDED**

For permanent rollback, would need to restore old backend code from version control.

---

## Next Steps

1. **Immediate:** Test backend endpoints against powerBI_Data
2. **Short-term:** Resolve pipeline_run_log table issue
3. **Long-term:** Monitor data freshness and accuracy
4. **Maintenance:** Keep track of any schema changes in ETL pipeline

---

## Technical Details

### Query Execution Flow

1. **Frontend** sends filter request (e.g., `/api/filters/business-units`)
2. **Auth Middleware** validates JWT token
3. **Routes** layer receives request → `/filters/business-units`
4. **Query** executes: `SELECT CompanyKey, Company FROM Dim_Company`
5. **Alias** applied in SELECT for API compatibility: `AS company_key, AS company_name`
6. **Response** sent to frontend in expected format

### Filter Application in Measures

1. **Frontend** sends filtered request: `/api/tachometer/overview?company=1`
2. **Routes** parses filters → `{ companyKey: 1 }`
3. **Measures** receives filters object
4. **buildWhereClause()** generates SQL:
   ```sql
   WHERE ... AND CompanyKey = 1 AND ...
   ```
5. **Query** executes against Fact_Orders/Fact_Targets
6. **Results** returned to frontend

---

## Files Summary

### Modified Backend Files (7)
- `backend/.env` - Database configuration
- `backend/src/measures/tachometer.ts` - Core KPI queries (4 functions updated)
- `backend/src/measures/filters.ts` - Filter column mappings
- `backend/src/measures/refreshStatus.ts` - Last update/refresh queries
- `backend/src/routes/filters.ts` - Filter endpoints (5 endpoints updated)
- `backend/src/middleware/scopeContext.ts` - Documentation

### Frontend Files (0)
- No changes required - backend API contract maintained

### Configuration Files (1)
- `backend/.env` - Database credentials

---

## Success Metrics

Dashboard is successfully connected to powerBI_Data when:

1. ✅ Backend starts without database errors
2. ✅ Filter dropdowns populate with data
3. ✅ Dashboard KPI cards display values
4. ✅ Breakdown pages show filtered data
5. ✅ PDF exports include current data
6. ✅ Data freshness matches database
7. ✅ All filter combinations work correctly
8. ✅ No SQL errors in backend logs

---

## Questions & Troubleshooting

**Q: Why are table names in PascalCase (Fact_Orders) instead of snake_case (fact_order)?**
A: The powerBI_Data database uses PascalCase naming convention from the Python ETL pipeline. Exact case match is required for MySQL compatibility.

**Q: Why use column aliases instead of updating the frontend?**
A: Aliases maintain API backward compatibility - frontend expects `company_key`/`company_name` but database provides `CompanyKey`/`Company`.

**Q: What if a filter endpoint returns an empty array?**
A: Check that:
1. Data exists in the corresponding dimension table
2. Connection to powerBI_Data is successful
3. User has permission to read the table
4. Table name case matches exactly

**Q: Can I use the old ps_warehouse database?**
A: Yes, by changing `DB_NAME` back to `ps_warehouse` in `.env`, but the code would need to be reverted to use old table/column names.

---

## Additional Resources

- Data Dictionary: `/PowerBIData/powerbi_sales_pipeline/DATA_DICTIONARY.md`
- ETL Pipeline: `/PowerBIData/powerbi_sales_pipeline/` (Python code)
- Database Schema: Check powerBI_Data tables directly via MySQL client

---

**Last Updated:** 2026-07-07  
**Status:** ✅ Complete & Ready for Testing  
**Next Phase:** Integration Testing & Deployment
