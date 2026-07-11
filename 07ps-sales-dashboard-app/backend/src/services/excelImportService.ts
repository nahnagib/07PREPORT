import { ValidationError } from '../lib/errors';
import ExcelJS from 'exceljs';
import { validatePasswordPolicy } from '../lib/password';
import { createUser, getUserByEmail, listRoles, RoleRow, UserStatus } from './userService';

const REQUIRED_HEADERS = ['full name', 'email', 'role'];
const VALID_STATUSES: UserStatus[] = ['ACTIVE', 'INACTIVE', 'LOCKED', 'PENDING_PASSWORD_CHANGE'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ParsedRow {
  rowNumber: number;
  fullName: string;
  email: string;
  roleRaw: string;
  tempPassword: string;
  statusRaw: string;
  salespersonKeyRaw: string;
}

export interface ImportRowError {
  rowNumber: number;
  email: string;
  errors: string[];
}

export interface ImportRowSuccess {
  rowNumber: number;
  email: string;
  fullName: string;
  role: string;
}

export interface ImportResult {
  totalRows: number;
  createdCount: number;
  errorCount: number;
  errors: ImportRowError[];
  created: ImportRowSuccess[];
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'text' in (value as Record<string, unknown>)) {
    return String((value as { text: unknown }).text ?? '').trim();
  }
  return String(value).trim();
}

export async function importUsersFromWorkbook(buffer: Buffer): Promise<ImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new ValidationError('The uploaded file has no worksheets.');
  }

  const headerRow = sheet.getRow(1);
  const columnIndex: Record<string, number> = {};
  headerRow.eachCell((cell, colNumber) => {
    columnIndex[normalizeHeader(cell.value)] = colNumber;
  });

  const missing = REQUIRED_HEADERS.filter((h) => columnIndex[h] === undefined);
  if (missing.length > 0) {
    throw new ValidationError(`Missing required column(s): ${missing.join(', ')}`);
  }

  const parsedRows: ParsedRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const get = (header: string) => {
      const col = columnIndex[header];
      return col ? cellText(row.getCell(col).value) : '';
    };
    const fullName = get('full name');
    const email = get('email');
    // A fully blank row (common trailing rows in exported sheets) is skipped, not reported as an error.
    if (!fullName && !email) return;
    parsedRows.push({
      rowNumber,
      fullName,
      email,
      roleRaw: get('role'),
      tempPassword: get('temporary password'),
      statusRaw: get('status'),
      salespersonKeyRaw: get('salesperson key'),
    });
  });

  const roles = await listRoles();
  const roleByName = new Map<string, RoleRow>();
  roles.forEach((r) => {
    roleByName.set(r.role_name.toLowerCase(), r);
    roleByName.set(r.role_label.toLowerCase(), r);
  });

  const seenEmailsInFile = new Set<string>();
  const errors: ImportRowError[] = [];
  const created: ImportRowSuccess[] = [];

  for (const row of parsedRows) {
    const rowErrors: string[] = [];
    const emailKey = row.email.toLowerCase();

    if (!row.fullName) rowErrors.push('Full Name is required.');
    if (!row.email) {
      rowErrors.push('Email is required.');
    } else if (!EMAIL_RE.test(row.email)) {
      rowErrors.push('Email is not a valid address.');
    } else if (seenEmailsInFile.has(emailKey)) {
      rowErrors.push('Duplicate email within this file.');
    }

    let role: RoleRow | undefined;
    if (!row.roleRaw) {
      rowErrors.push('Role is required.');
    } else {
      role = roleByName.get(row.roleRaw.toLowerCase());
      if (!role) {
        rowErrors.push(
          `Unknown role "${row.roleRaw}". Valid roles: ${roles.map((r) => r.role_label).join(', ')}.`,
        );
      }
    }

    let status: UserStatus = 'PENDING_PASSWORD_CHANGE';
    if (row.statusRaw) {
      const normalized = row.statusRaw.trim().toUpperCase().replace(/\s+/g, '_') as UserStatus;
      if (!VALID_STATUSES.includes(normalized)) {
        rowErrors.push(
          `Unknown status "${row.statusRaw}". Valid values: Active, Inactive, Locked, Pending Password Change.`,
        );
      } else {
        status = normalized;
      }
    }

    const tempPassword = row.tempPassword || undefined;
    if (tempPassword) {
      const policyError = validatePasswordPolicy(tempPassword);
      if (policyError) rowErrors.push(policyError);
    }

    let salespersonKey: number | null = null;
    if (row.salespersonKeyRaw) {
      const parsed = Number(row.salespersonKeyRaw);
      if (Number.isNaN(parsed)) {
        rowErrors.push('Salesperson Key must be a number.');
      } else {
        salespersonKey = parsed;
      }
    }

    // DB duplicate check only once the row is otherwise well-formed, to avoid a spurious extra
    // error on a row whose email was already invalid for another reason.
    if (row.email && EMAIL_RE.test(row.email) && !seenEmailsInFile.has(emailKey)) {
      const existing = await getUserByEmail(row.email);
      if (existing) rowErrors.push('A user with this email already exists.');
    }

    if (rowErrors.length > 0) {
      errors.push({ rowNumber: row.rowNumber, email: row.email, errors: rowErrors });
      continue;
    }

    seenEmailsInFile.add(emailKey);

    try {
      await createUser({
        fullName: row.fullName,
        email: row.email,
        roleId: role!.role_id,
        status,
        tempPassword,
        salespersonKey,
      });
      created.push({
        rowNumber: row.rowNumber,
        email: row.email,
        fullName: row.fullName,
        role: role!.role_label,
      });
    } catch (err) {
      errors.push({
        rowNumber: row.rowNumber,
        email: row.email,
        errors: [err instanceof Error ? err.message : 'Failed to create user.'],
      });
    }
  }

  return {
    totalRows: parsedRows.length,
    createdCount: created.length,
    errorCount: errors.length,
    errors,
    created,
  };
}

export async function buildTemplateWorkbook(): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Users');
  sheet.columns = [
    { header: 'Full Name', key: 'fullName', width: 24 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Role', key: 'role', width: 18 },
    { header: 'Temporary Password', key: 'tempPassword', width: 20 },
    { header: 'Status', key: 'status', width: 24 },
    { header: 'Salesperson Key', key: 'salespersonKey', width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.addRow({
    fullName: 'Jane Doe',
    email: 'jane.doe@example.com',
    role: 'B2B Director',
    tempPassword: '',
    status: 'Pending Password Change',
    salespersonKey: '',
  });
  sheet.addRow({
    fullName: '(Temporary Password and Status are optional - left blank, a password is ' +
      'generated and emailed, and Status defaults to Pending Password Change)',
  });

  const rolesSheet = workbook.addWorksheet('Valid Roles');
  rolesSheet.columns = [{ header: 'Role', key: 'role', width: 24 }];
  rolesSheet.getRow(1).font = { bold: true };
  const roles = await listRoles();
  roles.forEach((r) => rolesSheet.addRow({ role: r.role_label }));

  return workbook.xlsx.writeBuffer();
}
