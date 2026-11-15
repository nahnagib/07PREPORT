import { createHash } from 'node:crypto';
import { pool } from '../../db/pool';
import { PdpError, notFound } from './errors';
import { exec, isoDateTime, one } from './db';
import { projectIdForOwner, history } from './projectService';
import { zipEntryNames } from './zip';

/**
 * Attachments (checklist evidence, field-trial photos, launch/feedback files), stored in MySQL like MARCOM's uploaded
 * files. 10 MB per file; PDF, images (PNG, JPEG, GIF, WebP), DOCX and XLSX only -- the extension must match the
 * file's own signature, so a renamed file is refused.
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const OWNER_TYPES = ['checklist', 'field_trial', 'project', 'launch', 'feedback', 'doc_error'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

const KINDS: { ext: string[]; mime: string; test: (b: Buffer) => boolean }[] = [
  { ext: ['pdf'], mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { ext: ['png'], mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ['jpg', 'jpeg'], mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ['gif'], mime: 'image/gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: ['webp'], mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ext: ['docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', test: (b) => isOffice(b, 'word/document.xml') },
  { ext: ['xlsx'], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', test: (b) => isOffice(b, 'xl/workbook.xml') },
];

function isOffice(b: Buffer, part: string): boolean {
  if (b.readUInt32LE(0) !== 0x04034b50) return false;
  try {
    return zipEntryNames(b).includes(part);
  } catch {
    return false;
  }
}

export const ALLOWED_EXTENSIONS = KINDS.flatMap((k) => k.ext);

/** The MIME type for an allowed, genuine file; throws otherwise. */
export function sniffAttachment(fileName: string, buf: Buffer): string {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const kind = KINDS.find((k) => k.ext.includes(ext));
  if (!kind) throw new PdpError('attachment.type', 'Only PDF, images (PNG, JPEG, GIF, WebP), DOCX and XLSX files are accepted.', 'file');
  if (buf.length === 0) throw new PdpError('attachment.empty', 'The file is empty.', 'file');
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new PdpError('attachment.size', 'Files are limited to 10 MB.', 'file', 413);
  if (buf.length < 12 || !kind.test(buf)) throw new PdpError('attachment.mismatch', `The file is not a real .${ext} file.`, 'file');
  return kind.mime;
}

async function ownerProject(ck: number, ownerType: OwnerType, ownerId: number) {
  if (ownerType === 'launch') {
    if (!(await one(pool, 'SELECT 1 FROM pdp_launch WHERE company_key = ? AND launch_id = ? AND deleted_at IS NULL', [ck, ownerId]))) throw notFound('launch');
    return null;
  }
  if (ownerType === 'feedback') {
    if (!(await one(pool, 'SELECT 1 FROM pdp_customer_feedback WHERE company_key = ? AND feedback_id = ? AND deleted_at IS NULL', [ck, ownerId]))) throw notFound('feedback');
    return null;
  }
  const r = await projectIdForOwner(ck, ownerType, ownerId);
  if (!r.projectId) throw notFound('record');
  return r;
}

export async function uploadAttachment(ck: number, ownerType: unknown, ownerId: unknown, file: { originalname: string; buffer: Buffer }, actor: number, isAdmin: boolean) {
  if (!OWNER_TYPES.includes(ownerType as OwnerType)) throw new PdpError('attachment.owner', 'Unknown attachment target.', 'ownerType');
  const oid = Number(ownerId);
  if (!Number.isInteger(oid) || oid <= 0) throw new PdpError('attachment.owner', 'Unknown attachment target.', 'ownerId');
  const owner = await ownerProject(ck, ownerType as OwnerType, oid);
  if (owner && !isAdmin && (owner.state === 'closed' || owner.state === 'rejected')) throw new PdpError('project.closed', 'This project is read-only.', undefined, 409);
  const name = file.originalname.replace(/[\\/]/g, '_').slice(0, 255);
  const mime = sniffAttachment(name, file.buffer);
  const sha = createHash('sha256').update(file.buffer).digest('hex');
  const r = await exec(pool,
    'INSERT INTO pdp_attachment (company_key, owner_type, owner_id, file_name, mime_type, size_bytes, sha256, content, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ck, ownerType, oid, name, mime, file.buffer.length, sha, file.buffer, actor, actor]);
  if (owner?.projectId) await history(pool, ck, owner.projectId, 'attachment_added', null, name, null, actor);
  return { attachment_id: r.insertId, file_name: name, mime_type: mime, size_bytes: file.buffer.length };
}

export async function getAttachment(ck: number, attachmentId: number) {
  const r = await one<{ file_name: string; mime_type: string; content: Buffer; created_at: unknown }>(pool,
    'SELECT file_name, mime_type, content, created_at FROM pdp_attachment WHERE company_key = ? AND attachment_id = ? AND deleted_at IS NULL', [ck, attachmentId]);
  if (!r) throw notFound('attachment');
  return { ...r, created_at: isoDateTime(r.created_at) };
}

export async function deleteAttachment(ck: number, attachmentId: number, actor: number, isAdmin: boolean) {
  const a = await one<{ owner_type: OwnerType; owner_id: number; file_name: string }>(pool, 'SELECT owner_type, owner_id, file_name FROM pdp_attachment WHERE company_key = ? AND attachment_id = ? AND deleted_at IS NULL', [ck, attachmentId]);
  if (!a) throw notFound('attachment');
  const owner = await ownerProject(ck, a.owner_type, Number(a.owner_id)).catch(() => null);
  if (owner && !isAdmin && (owner.state === 'closed' || owner.state === 'rejected' || owner.state === 'launched')) throw new PdpError('project.closed', 'This project is read-only.', undefined, 409);
  await exec(pool, 'UPDATE pdp_attachment SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE attachment_id = ?', [actor, attachmentId]);
  if (owner?.projectId) await history(pool, ck, owner.projectId, 'attachment_deleted', a.file_name, null, null, actor);
}
