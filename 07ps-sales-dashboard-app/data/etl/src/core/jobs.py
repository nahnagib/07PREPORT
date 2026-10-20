"""core_dims: extract the shared reference data and build the conformed dimensions.

  extract_*        Odoo -> raw_odoo_* (incremental by write_date where the model supports it)
  load_*_file      Excel -> raw_excel_* (validated, replaced as a whole)
  build_*          raw -> dim_* / map_* (pure transforms in core.transforms, then upsert/replace)

Dimensions are upserted on their natural key and never deleted: a key that disappears from its source stays
(facts may still reference it). Maps that must mirror their source exactly (Odoo user -> salesperson, product ->
master, off days) are replaced as a whole. Departments run ``core_dims`` first (``depends_on_jobs``); the runner
reuses a success from the last ETL_CORE_DIMS_FRESH_MINUTES.
"""

from __future__ import annotations

import datetime as _dt
import os

import pandas as pd
from sqlalchemy import text

from core import excel_inputs as xl
from core import labels as lbl
from core.keys import UNKNOWN
from core.odoo_raw import RawField, RawOdooSpec, extract_odoo_raw, records_to_frame
from core.transforms import calendar as cal
from core.transforms import customer as cust
from core.transforms import org
from core.transforms import product as prod
from core.transforms import reference as ref
from etl_platform import quality as q
from etl_platform.load import ChangeSet, replace_changed, upsert, upsert_changed
from etl_platform.notify import notify
from etl_platform.registry import REGISTRY, DatasetSpec, JobSpec, TaskSpec
from etl_platform.runner import RunContext, TaskResult

DEPARTMENT = "core"
COMMERCIAL_DOMAIN = ("|", ("parent_id", "=", False), ("is_company", "=", True))


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


def _read(ctx: RunContext, sql: str) -> pd.DataFrame:
    with ctx.engine.connect() as conn:
        return pd.read_sql(text(sql), conn)


def _stamp(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["updated_at_utc"] = _now()
    return out


def _changes(*sets: ChangeSet) -> dict:
    """etl_task_log.details["changed"]: per table, rows inserted / updated / deleted / unchanged (+ deleted keys).
    updated_at_utc moves only on real changes, so the incremental sales step finds changed records by it."""
    return {cs.table: cs.summary() for cs in sets}


# -- Odoo raw specs ----------------------------------------------------------------------------------------------
F = RawField
ODOO_RAW = {
    "raw_odoo_res_company": RawOdooSpec("raw_odoo_res_company", "res.company", "raw_odoo_res_company",
        (F("name", "name"), F("currency_id", "currency_id", "m2o_id"), F("currency_name", "currency_id", "m2o_name")), incremental=False),
    "raw_odoo_res_currency": RawOdooSpec("raw_odoo_res_currency", "res.currency", "raw_odoo_res_currency",
        (F("name", "name"), F("symbol", "symbol"), F("decimal_places", "decimal_places", "int"), F("active", "active", "bool")), incremental=False),
    "raw_odoo_res_users": RawOdooSpec("raw_odoo_res_users", "res.users", "raw_odoo_res_users",
        (F("name", "name"), F("partner_id", "partner_id", "m2o_id"), F("company_id", "company_id", "m2o_id"),
         F("share", "share", "bool"), F("active", "active", "bool"))),
    "raw_odoo_crm_team": RawOdooSpec("raw_odoo_crm_team", "crm.team", "raw_odoo_crm_team",
        (F("name", "name"), F("company_id", "company_id", "m2o_id"), F("active", "active", "bool")), incremental=False),
    "raw_odoo_res_partner": RawOdooSpec("raw_odoo_res_partner", "res.partner", "raw_odoo_res_partner",
        (F("name", "name"), F("display_name", "display_name"), F("commercial_partner_id", "commercial_partner_id", "m2o_id"),
         F("parent_id", "parent_id", "m2o_id"), F("is_company", "is_company", "bool"), F("customer_rank", "customer_rank", "int"),
         F("supplier_rank", "supplier_rank", "int"), F("user_id", "user_id", "m2o_id"), F("company_id", "company_id", "m2o_id"),
         F("type", "type"), F("ref", "ref"), F("active", "active", "bool"))),
    "raw_odoo_product_product": RawOdooSpec("raw_odoo_product_product", "product.product", "raw_odoo_product_product",
        (F("product_tmpl_id", "product_tmpl_id", "m2o_id"), F("name", "name"), F("display_name", "display_name"),
         F("default_code", "default_code"), F("company_id", "company_id", "m2o_id"), F("categ_id", "categ_id", "m2o_id"),
         F("categ_name", "categ_id", "m2o_name"), F("uom_id", "uom_id", "m2o_id"), F("uom_name", "uom_id", "m2o_name"),
         F("detailed_type", "detailed_type"), F("active", "active", "bool"))),
    "raw_odoo_account_payment_term": RawOdooSpec("raw_odoo_account_payment_term", "account.payment.term", "raw_odoo_account_payment_term",
        (F("name", "name"), F("company_id", "company_id", "m2o_id"), F("active", "active", "bool"))),
    "raw_odoo_account_payment_term_line": RawOdooSpec("raw_odoo_account_payment_term_line", "account.payment.term.line", "raw_odoo_account_payment_term_line",
        (F("payment_id", "payment_id", "m2o_id"), F("value", "value"), F("value_amount", "value_amount", "float"),
         F("nb_days", "nb_days", "int"), F("delay_type", "delay_type"))),
}
PARTNER_COMPANY_SPEC = RawOdooSpec("raw_odoo_res_partner_company", "res.partner", "raw_odoo_res_partner_company",
                                   (F("credit_limit", "credit_limit", "float"), F("property_payment_term_id", "property_payment_term_id", "m2o_id")),
                                   domain=COMMERCIAL_DOMAIN, incremental=False)


def _odoo_task(dataset: str):
    def fn(ctx: RunContext) -> TaskResult:
        return extract_odoo_raw(ctx, ODOO_RAW[dataset])
    fn.__name__ = f"extract_{dataset}"
    return fn


def extract_partner_company(ctx: RunContext) -> TaskResult:
    """Company-dependent partner properties (credit limit, default payment term), read once per in-scope
    company: Odoo returns company-dependent values for the first allowed company of the context."""
    spec = PARTNER_COMPANY_SPEC
    source = ctx.odoo(spec.profile)
    fields, skipped = source.available_fields(spec.model, spec.odoo_fields)
    frames, total = [], 0
    company_ids = ctx.odoo_company_ids(spec.profile)
    for company_id in company_ids:
        records = source.search_read_all(spec.model, spec.domain, fields, include_archived=True, company_ids=[company_id])
        total += len(records)
        df = records_to_frame(records, spec, run_uid=ctx.run_uid, extracted_at=_now(), available=fields)
        df = df.rename(columns={"id": "partner_id"})
        df.insert(1, "company_id", company_id)
        frames.append(df)
    df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    with ctx.engine.begin() as conn:
        loaded = upsert(conn, spec.table, df) if len(df) else 0
    return TaskResult(rows_extracted=total, rows_loaded=loaded, details={"companies": list(company_ids), "skipped_fields": skipped})


# -- Excel -------------------------------------------------------------------------------------------------------
def load_org_file(ctx: RunContext) -> TaskResult:
    total = TaskResult()
    for spec in xl.INPUTS:
        if spec.file == xl.ORG_FILE:
            r = xl.load_excel_input(ctx, spec)
            total.rows_extracted += r.rows_extracted
            total.rows_loaded += r.rows_loaded
    return total


def _excel_task(dataset: str, transform=None):
    spec = next(s for s in xl.INPUTS if s.dataset == dataset)

    def fn(ctx: RunContext) -> TaskResult:
        return xl.load_excel_input(ctx, spec, transform=transform)
    fn.__name__ = f"load_{dataset}"
    return fn


# -- builds ------------------------------------------------------------------------------------------------------
def build_reference_dims(ctx: RunContext) -> TaskResult:
    company_ids = ctx.odoo_company_ids()
    companies = ref.build_companies(_read(ctx, "SELECT * FROM raw_odoo_res_company"), company_ids)
    currencies = ref.build_currencies(_read(ctx, "SELECT * FROM raw_odoo_res_currency"))
    terms = ref.build_payment_terms(_read(ctx, "SELECT * FROM raw_odoo_account_payment_term"),
                                    _read(ctx, "SELECT * FROM raw_odoo_account_payment_term_line"))
    missing_scope = set(company_ids) - set(companies["CompanyKey"])
    if missing_scope:
        raise RuntimeError(f"Configured Odoo company id(s) {sorted(missing_scope)} not found in res.company")
    with ctx.engine.begin() as conn:
        sets = [upsert_changed(conn, "dim_currency", currencies), upsert_changed(conn, "dim_company", companies),
                upsert_changed(conn, "dim_payment_term", terms)]
    return TaskResult(rows_loaded=sum(c.written for c in sets),
                      details={"companies": len(companies), "currencies": len(currencies), "payment_terms": len(terms), "changed": _changes(*sets)})


def _company_maps(ctx: RunContext) -> tuple[dict[int, str], dict[str, int]]:
    rows = _read(ctx, "SELECT CompanyKey, Company FROM dim_company WHERE is_in_scope = 1")
    names = dict(zip(rows["CompanyKey"].astype(int), rows["Company"]))
    return names, {v: k for k, v in names.items()}


def build_org_dims(ctx: RunContext) -> TaskResult:
    sp = _read(ctx, "SELECT * FROM raw_excel_salesperson")
    team = _read(ctx, "SELECT * FROM raw_excel_sales_team")
    users = _read(ctx, "SELECT * FROM raw_excel_odoo_users")
    channel = _read(ctx, "SELECT * FROM raw_excel_channel")
    segment = _read(ctx, "SELECT * FROM raw_excel_segment")
    names, _ = _company_maps(ctx)
    sp, team, users, channel, segment = org.normalize_org(sp, team, users, channel, segment)
    org.validate_org(sp, team, users, channel, segment, set(names))
    odoo_users = _read(ctx, "SELECT id, name FROM raw_odoo_res_users")
    unknown_users = sorted(set(users["odoo_user_id"]) - set(odoo_users["id"]))
    if unknown_users:
        notify("WARNING", f"SalesTeam.xlsx OdooUsers lists user id(s) that do not exist in Odoo: {unknown_users}")
    channels, segments = org.build_channels(channel), org.build_segments(segment)
    teams, people = org.build_sales_teams(team, names), org.build_salespeople(sp)
    stale_active = org.active_without_team(sp)
    if len(stale_active):
        notify("WARNING", "SalesTeam.xlsx: Status says Active but no team, so treated as Inactive (clean up the sheet): "
                          + ", ".join(f"{k} {n}" for k, n in zip(stale_active["SalespersonKey"], stale_active["Name"])))
    user_map = org.build_user_map(users, odoo_users)
    teams_sheet = _read(ctx, "SELECT * FROM raw_excel_odoo_teams")
    org.validate_team_map(teams_sheet, team)
    odoo_teams = _read(ctx, "SELECT id, name FROM raw_odoo_crm_team")
    team_map = org.build_team_map(teams_sheet, odoo_teams)
    unknown_teams = sorted(set(team_map["odoo_team_id"]) - set(odoo_teams["id"]))
    if unknown_teams:
        notify("WARNING", f"SalesTeam.xlsx OdooTeams lists team id(s) that do not exist in Odoo: {unknown_teams}")
    unlisted = odoo_teams[~odoo_teams["id"].isin(team_map["odoo_team_id"])]
    if len(unlisted):
        notify("WARNING", "Odoo team(s) not in SalesTeam.xlsx OdooTeams (their documents go to team -1): "
                          + ", ".join(f"{i} {n}" for i, n in zip(unlisted["id"], unlisted["name"])))
    with ctx.engine.begin() as conn:
        sets = [upsert_changed(conn, "dim_channel", channels), upsert_changed(conn, "dim_segment", segments),
                upsert_changed(conn, "dim_sales_team", teams), upsert_changed(conn, "dim_salesperson", people),
                replace_changed(conn, "map_odoo_user_salesperson", user_map), replace_changed(conn, "map_odoo_team_sales_team", team_map)]
    return TaskResult(rows_loaded=sum(c.written for c in sets), details={"changed": _changes(*sets), "salespeople": len(people), "teams": len(teams), "odoo_users_mapped": len(user_map),
                                              "odoo_teams_mapped": len(team_map),
                                              "inactive_no_team": int((people["assigned_team_key"].isna()).sum()),
                                              "active_status_without_team": stale_active["SalespersonKey"].tolist()})


def build_customer_dims(ctx: RunContext) -> TaskResult:
    partners = _read(ctx, "SELECT * FROM raw_odoo_res_partner")
    user_map = _read(ctx, "SELECT odoo_user_id, SalespersonKey FROM map_odoo_user_salesperson")
    blocked = _read(ctx, "SELECT * FROM raw_excel_blocked_customers")
    customers, unmapped_users = cust.build_customers(partners, dict(zip(user_map["odoo_user_id"], user_map["SalespersonKey"])), blocked)
    partner_map = cust.build_partner_map(partners)
    terms = _read(ctx, "SELECT PaymentTermKey FROM dim_payment_term")
    per_company = cust.build_customer_company(_read(ctx, "SELECT * FROM raw_odoo_res_partner_company"), partner_map, terms["PaymentTermKey"])
    if unmapped_users:
        ctx.record_fallback("dim_customer.SalespersonKey (partner.user_id not in OdooUsers)", unmapped_users)
    unresolved = cust.blocked_without_customer(blocked, customers["CustomerKey"])
    if len(unresolved):
        notify("WARNING", f"BlockedCustomers.xlsx: {len(unresolved)} row(s) without a valid CustomerKey are ignored: "
                          + ", ".join(f"row {r} ({n})" for r, n in zip(unresolved["_excel_row"], unresolved["CustomerName"]))[:2000])
    with ctx.engine.begin() as conn:
        sets = [upsert_changed(conn, "dim_customer", customers, update_columns=list(cust.CORE_CUSTOMER_COLUMNS)),
                upsert_changed(conn, "map_partner_customer", partner_map), upsert_changed(conn, "dim_customer_company", per_company)]
    return TaskResult(rows_loaded=sum(c.written for c in sets), details={"changed": _changes(*sets), "customers": len(customers), "is_customer": int(customers["is_customer"].sum()),
                                              "partners": len(partner_map), "customer_company_rows": len(per_company),
                                              "blocked_unresolved": len(unresolved)})


def build_product_dims(ctx: RunContext) -> TaskResult:
    names, by_name = _company_maps(ctx)
    raw_master = _read(ctx, "SELECT * FROM raw_excel_products")
    master = prod.build_product_master(raw_master, by_name)
    products = prod.build_products(_read(ctx, "SELECT * FROM raw_odoo_product_product"))
    # the sheet's optional OdooProductID column lets an id match win over the name match
    master_for_map = master.merge(raw_master[["ProductMasterKey", "OdooProductID"]], on="ProductMasterKey", how="left", validate="1:1")
    pm_map = prod.build_product_master_map(products, master_for_map, names)
    with ctx.engine.begin() as conn:
        sets = [upsert_changed(conn, "dim_product_master", master), upsert_changed(conn, "dim_product", products),
                replace_changed(conn, "map_product_master", pm_map)]
    unmatched = int((pm_map["match_status"] == prod.STATUS_NONE).sum())
    return TaskResult(rows_loaded=sum(c.written for c in sets), details={"products": len(products), "master_rows": len(master), "map_rows": len(pm_map),
                                                                         "unmatched": unmatched, "changed": _changes(*sets)})


def dim_date_start() -> _dt.date:
    return _dt.date.fromisoformat(os.getenv("ETL_DIM_DATE_START", "2018-01-01"))


def load_selection_labels(ctx: RunContext) -> TaskResult:
    """Odoo's own labels of the selection fields in core.labels.SELECTION_FIELDS, English + Arabic when active."""
    frame, info = lbl.read_labels(ctx.odoo())
    for col in ("label_en", "label_ar", "field_label_en", "field_label_ar"):
        frame[col] = frame[col].map(lambda v: v.strip() if isinstance(v, str) else v)  # some translations carry spaces
    if not info["arabic"]:
        notify("WARNING", "No Arabic language is active in Odoo: selection labels are stored in English only (label_ar NULL)")
    with ctx.engine.begin() as conn:
        cs = replace_changed(conn, "dim_odoo_selection_label", frame)
    return TaskResult(rows_extracted=len(frame), rows_loaded=cs.written, details={**info, "changed": _changes(cs)})


def ensure_date_range(conn, start: _dt.date, end: _dt.date) -> int:
    """For departments: make sure dim_date covers [start, end] before loading facts. Idempotent."""
    return upsert_changed(conn, "dim_date", cal.build_dates(start, end)).written


def build_calendar_dims(ctx: RunContext) -> TaskResult:
    start, end = cal.default_range(ctx.as_of, dim_date_start())
    _, by_name = _company_maps(ctx)
    offdays = cal.build_offdays(_read(ctx, "SELECT * FROM raw_excel_offdays"), by_name)
    with ctx.engine.begin() as conn:
        n = ensure_date_range(conn, start, end)
        if len(offdays):
            ensure_date_range(conn, min(offdays["Date"]), max(offdays["Date"]))
        cs = replace_changed(conn, "dim_offday", offdays)
        n += cs.written
    return TaskResult(rows_loaded=n, details={"date_range": [str(start), str(end)], "offdays": len(offdays), "changed": _changes(cs)})


# -- registration ------------------------------------------------------------------------------------------------
def _ds(name, layer, source, table, load, key, checks=(), **kw):
    return REGISTRY.dataset(DatasetSpec(name, DEPARTMENT, layer, source, table, load, key, checks=tuple(checks), **kw))


for name, spec in ODOO_RAW.items():
    _ds(name, "raw", "odoo", spec.table, "upsert", ("id",), model=spec.model, incremental_field="write_date" if spec.incremental else None)
_ds("raw_odoo_res_partner_company", "raw", "odoo", "raw_odoo_res_partner_company", "upsert", ("partner_id", "company_id"), model="res.partner")
for spec in xl.INPUTS:
    _ds(spec.dataset, "raw", "excel", spec.table, "replace", ("_excel_row",) if spec.row_is_key else (spec.schema.columns[0].name,), file=spec.file,
        sheet=spec.schema.candidates[0])

_o = q.orphan
_ds("dim_company", "core", "sql", "dim_company", "upsert", ("CompanyKey",), [_o("dim_company", "CurrencyKey", "dim_currency", "CurrencyKey")])
_ds("dim_currency", "core", "sql", "dim_currency", "upsert", ("CurrencyKey",))
_ds("dim_payment_term", "core", "sql", "dim_payment_term", "upsert", ("PaymentTermKey",), [_o("dim_payment_term", "CompanyKey", "dim_company", "CompanyKey")])
_ds("dim_channel", "core", "sql", "dim_channel", "upsert", ("ChannelKey",))
_ds("dim_segment", "core", "sql", "dim_segment", "upsert", ("SegmentKey",))
_ds("dim_sales_team", "core", "sql", "dim_sales_team", "upsert", ("SalesTeamKey",), [
    _o("dim_sales_team", "SegmentKey", "dim_segment", "SegmentKey"), _o("dim_sales_team", "CompanyKey", "dim_company", "CompanyKey")])
_ds("dim_salesperson", "core", "sql", "dim_salesperson", "upsert", ("SalespersonKey",), [
    _o("dim_salesperson", "SalesTeamKey", "dim_sales_team", "SalesTeamKey"), _o("dim_salesperson", "ChannelKey", "dim_channel", "ChannelKey"),
    q.custom_sql("warn:salesperson_active_status_without_team",  # no team = Inactive by rule; the sheet still says Active
                 "SELECT SalespersonKey, Name FROM raw_excel_salesperson WHERE UPPER(TRIM(Status)) = 'ACTIVE' "
                 "AND (TeamKey IS NULL OR TRIM(TeamKey) = '') ORDER BY SalespersonKey", table="dim_salesperson", severity="warn")])
_ds("map_odoo_user_salesperson", "core", "sql", "map_odoo_user_salesperson", "replace", ("odoo_user_id",), [
    _o("map_odoo_user_salesperson", "SalespersonKey", "dim_salesperson", "SalespersonKey")])
_ds("map_odoo_team_sales_team", "core", "sql", "map_odoo_team_sales_team", "replace", ("odoo_team_id",), [
    _o("map_odoo_team_sales_team", "SalesTeamKey", "dim_sales_team", "SalesTeamKey")])
_ds("dim_customer", "core", "sql", "dim_customer", "upsert", ("CustomerKey",), [_o("dim_customer", "SalespersonKey", "dim_salesperson", "SalespersonKey")])
_ds("map_partner_customer", "core", "sql", "map_partner_customer", "upsert", ("partner_id",), [_o("map_partner_customer", "CustomerKey", "dim_customer", "CustomerKey")])
_ds("dim_customer_company", "core", "sql", "dim_customer_company", "upsert", ("CustomerKey", "CompanyKey"), [
    _o("dim_customer_company", "CustomerKey", "dim_customer", "CustomerKey"), _o("dim_customer_company", "CompanyKey", "dim_company", "CompanyKey"),
    _o("dim_customer_company", "PaymentTermKey", "dim_payment_term", "PaymentTermKey")])
_ds("dim_product", "core", "sql", "dim_product", "upsert", ("ProductKey",), [_o("dim_product", "CompanyKey", "dim_company", "CompanyKey")])
_ds("dim_product_master", "core", "sql", "dim_product_master", "upsert", ("ProductMasterKey",), [_o("dim_product_master", "CompanyKey", "dim_company", "CompanyKey")])
_ds("map_product_master", "core", "sql", "map_product_master", "replace", ("ProductKey", "CompanyKey"), [
    _o("map_product_master", "ProductKey", "dim_product", "ProductKey"), _o("map_product_master", "ProductMasterKey", "dim_product_master", "ProductMasterKey"),
    _o("map_product_master", "CompanyKey", "dim_company", "CompanyKey")])
_ds("dim_date", "core", "sql", "dim_date", "upsert", ("DateKey",))
_ds("dim_odoo_selection_label", "core", "odoo", "dim_odoo_selection_label", "replace", ("model", "field", "value"), model="fields_get")
_ds("dim_offday", "core", "sql", "dim_offday", "replace", ("DateKey", "OffDayType", "CompanyKey", "SalesTeamKey"), [
    _o("dim_offday", "DateKey", "dim_date", "DateKey"), _o("dim_offday", "CompanyKey", "dim_company", "CompanyKey"),
    _o("dim_offday", "SalesTeamKey", "dim_sales_team", "SalesTeamKey")])

T = TaskSpec
EXTRACT_TASKS = []
for name in ODOO_RAW:
    REGISTRY.task(T(f"extract_{name}", _odoo_task(name), datasets=(name,)))
    EXTRACT_TASKS.append(f"extract_{name}")
REGISTRY.task(T("extract_raw_odoo_res_partner_company", extract_partner_company, datasets=("raw_odoo_res_partner_company",)))
REGISTRY.task(T("load_org_file", load_org_file, datasets=tuple(s.dataset for s in xl.INPUTS if s.file == xl.ORG_FILE)))
REGISTRY.task(T("load_products_file", _excel_task("raw_excel_products", prod.complete_master_keys), datasets=("raw_excel_products",)))
REGISTRY.task(T("load_offdays_file", _excel_task("raw_excel_offdays"), datasets=("raw_excel_offdays",)))
REGISTRY.task(T("load_blocked_customers_file", _excel_task("raw_excel_blocked_customers"), datasets=("raw_excel_blocked_customers",)))
REGISTRY.task(T("build_reference_dims", build_reference_dims,
                depends_on=("extract_raw_odoo_res_company", "extract_raw_odoo_res_currency", "extract_raw_odoo_account_payment_term",
                            "extract_raw_odoo_account_payment_term_line"),
                datasets=("dim_company", "dim_currency", "dim_payment_term")))
REGISTRY.task(T("build_org_dims", build_org_dims,
                depends_on=("load_org_file", "extract_raw_odoo_res_users", "extract_raw_odoo_crm_team", "build_reference_dims"),
                datasets=("dim_channel", "dim_segment", "dim_sales_team", "dim_salesperson", "map_odoo_user_salesperson", "map_odoo_team_sales_team")))
REGISTRY.task(T("build_customer_dims", build_customer_dims,
                depends_on=("extract_raw_odoo_res_partner", "extract_raw_odoo_res_partner_company", "load_blocked_customers_file", "build_org_dims"),
                datasets=("dim_customer", "map_partner_customer", "dim_customer_company")))
REGISTRY.task(T("build_product_dims", build_product_dims, depends_on=("extract_raw_odoo_product_product", "load_products_file", "build_reference_dims"),
                datasets=("dim_product", "dim_product_master", "map_product_master")))
REGISTRY.task(T("build_calendar_dims", build_calendar_dims, depends_on=("load_offdays_file", "build_org_dims"),
                datasets=("dim_date", "dim_offday")))
REGISTRY.task(T("load_selection_labels", load_selection_labels, datasets=("dim_odoo_selection_label",)))

REGISTRY.job(JobSpec(
    "core_dims", DEPARTMENT, mode="full", reuse_within_minutes="config",
    tasks=(*EXTRACT_TASKS, "extract_raw_odoo_res_partner_company", "load_org_file", "load_products_file", "load_offdays_file",
           "load_blocked_customers_file", "build_reference_dims", "build_org_dims", "build_customer_dims", "build_product_dims",
           "build_calendar_dims", "load_selection_labels"),
    description="Shared reference data (Odoo + Excel) -> conformed dimensions and maps.",
))
