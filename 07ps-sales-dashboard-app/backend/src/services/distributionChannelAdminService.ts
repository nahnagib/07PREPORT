import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';

/**
 * Admin-controlled reference data for Distribution Channel -- same overlay pattern as
 * customerGroupAdminService.ts (see that file's header, and
 * data/warehouse/migrations/0018_reference_data_admin.sql), applied to Dim_DistributionChannel
 * instead of Dim_Segment.
 *
 * Usage check only looks at salesperson_admin_profile.channel_key_override -- sales_team_admin_profile
 * has no channel column (only team_code/segment_key_override/target_override_amount/note), so a
 * distribution channel can only ever be "in use" via a salesperson, never a sales team.
 */

export interface DistributionChannelRow {
  distribution_channel_id: number;
  name: string;
  definition: string | null;
  etl_channel_key: number | null;
  etl_channel_name: string | null;
  display_order: number;
  is_active: boolean;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
  usage_count: number;
}

const BASE_SELECT = `
  SELECT
    c.distribution_channel_id, c.name, c.definition, c.etl_channel_key, c.etl_channel_name,
    c.display_order, c.is_active, c.created_at, cu.email AS created_by_email,
    c.updated_at, uu.email AS updated_by_email,
    COALESCE((
      SELECT COUNT(*) FROM salesperson_admin_profile WHERE channel_key_override = c.etl_channel_key
    ), 0) AS usage_count
  FROM admin_distribution_channel c
  LEFT JOIN app_user cu ON cu.user_id = c.created_by
  LEFT JOIN app_user uu ON uu.user_id = c.updated_by
`;

function withBool(row: DistributionChannelRow): DistributionChannelRow {
  return { ...row, is_active: Boolean(row.is_active), usage_count: Number(row.usage_count) };
}

export interface ListDistributionChannelsFilters {
  isActive?: boolean;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listDistributionChannels(
  filters: ListDistributionChannelsFilters,
): Promise<{ rows: DistributionChannelRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.isActive !== undefined) {
    clauses.push('c.is_active = ?');
    params.push(filters.isActive);
  }
  if (filters.search) {
    clauses.push('(c.name LIKE ? OR c.definition LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM admin_distribution_channel c ${where}`, params);
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (filters.page - 1) * filters.pageSize);
  const [rows] = await pool.query(
    `${BASE_SELECT} ${where} ORDER BY c.display_order, c.name LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );
  return { rows: (rows as DistributionChannelRow[]).map(withBool), total };
}

export async function getDistributionChannelById(id: number): Promise<DistributionChannelRow | null> {
  const [rows] = await pool.query(`${BASE_SELECT} WHERE c.distribution_channel_id = ?`, [id]);
  const row = (rows as DistributionChannelRow[])[0];
  return row ? withBool(row) : null;
}

async function nameTakenByAnother(name: string, excludeId?: number): Promise<boolean> {
  const [rows] = await pool.query(
    'SELECT 1 FROM admin_distribution_channel WHERE name = ? AND distribution_channel_id <> ? LIMIT 1',
    [name, excludeId ?? -1],
  );
  return (rows as unknown[]).length > 0;
}

async function etlChannelExists(channelKey: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM Dim_DistributionChannel WHERE ChannelKey = ? LIMIT 1', [channelKey]);
  return (rows as unknown[]).length > 0;
}

async function etlChannelTakenByAnother(channelKey: number, excludeId?: number): Promise<boolean> {
  const [rows] = await pool.query(
    'SELECT 1 FROM admin_distribution_channel WHERE etl_channel_key = ? AND distribution_channel_id <> ? LIMIT 1',
    [channelKey, excludeId ?? -1],
  );
  return (rows as unknown[]).length > 0;
}

async function usageCount(etlChannelKey: number | null): Promise<number> {
  if (etlChannelKey === null) return 0;
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS total FROM salesperson_admin_profile WHERE channel_key_override = ?',
    [etlChannelKey],
  );
  return Number((rows as { total: number }[])[0]?.total ?? 0);
}

async function recordHistory(
  distributionChannelId: number,
  row: { name: string; definition: string | null; etl_channel_key: number | null; etl_channel_name: string | null; display_order: number; is_active: boolean },
  action: 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE' | 'DELETE',
  actorUserId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO admin_distribution_channel_history
       (distribution_channel_id, name, definition, etl_channel_key, etl_channel_name, display_order, is_active, action, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [distributionChannelId, row.name, row.definition, row.etl_channel_key, row.etl_channel_name, row.display_order, row.is_active, action, actorUserId],
  );
}

export interface CreateDistributionChannelInput {
  name: string;
  definition?: string | null;
  etlChannelKey?: number | null;
  displayOrder?: number;
}

export async function createDistributionChannel(input: CreateDistributionChannelInput, actorUserId: number): Promise<DistributionChannelRow> {
  const name = input.name?.trim();
  if (!name) throw new ValidationError('Name is required.');
  if (await nameTakenByAnother(name)) throw new ValidationError(`"${name}" is already in use.`);

  let etlChannelName: string | null = null;
  if (input.etlChannelKey !== undefined && input.etlChannelKey !== null) {
    if (!(await etlChannelExists(input.etlChannelKey))) throw new ValidationError('Invalid ETL distribution channel selected.');
    if (await etlChannelTakenByAnother(input.etlChannelKey)) {
      throw new ValidationError('That ETL channel is already linked to another distribution channel.');
    }
    const [rows] = await pool.query('SELECT DistributionChannel FROM Dim_DistributionChannel WHERE ChannelKey = ?', [input.etlChannelKey]);
    etlChannelName = (rows as { DistributionChannel: string }[])[0]?.DistributionChannel ?? null;
  }

  const definition = input.definition ?? null;
  const etlChannelKey = input.etlChannelKey ?? null;
  const displayOrder = input.displayOrder ?? 0;

  const [result] = await pool.query(
    `INSERT INTO admin_distribution_channel (name, definition, etl_channel_key, etl_channel_name, display_order, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, definition, etlChannelKey, etlChannelName, displayOrder, actorUserId, actorUserId],
  );
  const id = (result as { insertId: number }).insertId;
  await recordHistory(id, { name, definition, etl_channel_key: etlChannelKey, etl_channel_name: etlChannelName, display_order: displayOrder, is_active: true }, 'CREATE', actorUserId);

  const row = await getDistributionChannelById(id);
  if (!row) throw new ValidationError('Distribution channel not found after creation.');
  return row;
}

export interface UpdateDistributionChannelInput {
  name?: string;
  definition?: string | null;
  etlChannelKey?: number | null;
  displayOrder?: number;
  isActive?: boolean;
}

export async function updateDistributionChannel(id: number, input: UpdateDistributionChannelInput, actorUserId: number): Promise<DistributionChannelRow> {
  const existing = await getDistributionChannelById(id);
  if (!existing) throw new ValidationError('Distribution channel not found.');

  let name = existing.name;
  if (input.name !== undefined) {
    name = input.name.trim();
    if (!name) throw new ValidationError('Name cannot be empty.');
    if (await nameTakenByAnother(name, id)) throw new ValidationError(`"${name}" is already in use.`);
  }

  let etlChannelKey = existing.etl_channel_key;
  let etlChannelName = existing.etl_channel_name;
  if (input.etlChannelKey !== undefined) {
    if (input.etlChannelKey === null) {
      etlChannelKey = null;
      etlChannelName = null;
    } else {
      if (!(await etlChannelExists(input.etlChannelKey))) throw new ValidationError('Invalid ETL distribution channel selected.');
      if (await etlChannelTakenByAnother(input.etlChannelKey, id)) {
        throw new ValidationError('That ETL channel is already linked to another distribution channel.');
      }
      const [rows] = await pool.query('SELECT DistributionChannel FROM Dim_DistributionChannel WHERE ChannelKey = ?', [input.etlChannelKey]);
      etlChannelKey = input.etlChannelKey;
      etlChannelName = (rows as { DistributionChannel: string }[])[0]?.DistributionChannel ?? null;
    }
  }

  const definition = input.definition !== undefined ? input.definition : existing.definition;
  const displayOrder = input.displayOrder !== undefined ? input.displayOrder : existing.display_order;

  let isActive = existing.is_active;
  let action: 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE' = 'UPDATE';
  if (input.isActive !== undefined && input.isActive !== existing.is_active) {
    if (input.isActive === false) {
      const used = await usageCount(etlChannelKey);
      if (used > 0) {
        throw new ValidationError(`This distribution channel is assigned to ${used} salesperson record(s). Reassign them before deactivating.`);
      }
      action = 'DEACTIVATE';
    } else {
      action = 'REACTIVATE';
    }
    isActive = input.isActive;
  }

  await pool.query(
    `UPDATE admin_distribution_channel
     SET name = ?, definition = ?, etl_channel_key = ?, etl_channel_name = ?, display_order = ?, is_active = ?, updated_by = ?
     WHERE distribution_channel_id = ?`,
    [name, definition, etlChannelKey, etlChannelName, displayOrder, isActive, actorUserId, id],
  );
  await recordHistory(id, { name, definition, etl_channel_key: etlChannelKey, etl_channel_name: etlChannelName, display_order: displayOrder, is_active: isActive }, action, actorUserId);

  const row = await getDistributionChannelById(id);
  if (!row) throw new ValidationError('Distribution channel not found after update.');
  return row;
}

export async function deleteDistributionChannel(id: number, actorUserId: number): Promise<void> {
  const existing = await getDistributionChannelById(id);
  if (!existing) throw new ValidationError('Distribution channel not found.');
  const used = await usageCount(existing.etl_channel_key);
  if (used > 0) {
    throw new ValidationError(`This distribution channel is assigned to ${used} salesperson record(s) and cannot be deleted. Reassign them, or deactivate instead.`);
  }
  await recordHistory(
    id,
    {
      name: existing.name,
      definition: existing.definition,
      etl_channel_key: existing.etl_channel_key,
      etl_channel_name: existing.etl_channel_name,
      display_order: existing.display_order,
      is_active: existing.is_active,
    },
    'DELETE',
    actorUserId,
  );
  await pool.query('DELETE FROM admin_distribution_channel WHERE distribution_channel_id = ?', [id]);
}

export interface EtlChannelOption {
  channel_key: number;
  channel_name: string;
}

export async function getEtlChannelOptions(): Promise<EtlChannelOption[]> {
  const [rows] = await pool.query('SELECT ChannelKey AS channel_key, DistributionChannel AS channel_name FROM Dim_DistributionChannel ORDER BY ChannelKey');
  return rows as EtlChannelOption[];
}
