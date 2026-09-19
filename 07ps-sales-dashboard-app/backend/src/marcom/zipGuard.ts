import { ValidationError } from '../lib/errors';
import { MAX_FILE_BYTES } from './templateConfig';

const MAX_ENTRIES = 300;
const MAX_UNCOMPRESSED_TOTAL = 150 * 1024 * 1024;
const MAX_RATIO = 250;

/**
 * Cheap structural checks on an uploaded .xlsx *before* it is handed to the XML/zip parser:
 * real ZIP signature (not just the extension), size cap, zip-bomb limits (declared uncompressed
 * size / entry count / compression ratio read from the central directory, so nothing is inflated
 * to find out), and rejection of macro-enabled workbooks and external links.
 */
export function assertSafeXlsx(buf: Buffer, filename: string): void {
  if (!/\.xlsx$/i.test(filename)) {
    throw new ValidationError('Only .xlsx files are accepted (not .xlsm, .xls or other formats).');
  }
  if (buf.length === 0) throw new ValidationError('The uploaded file is empty.');
  if (buf.length > MAX_FILE_BYTES) {
    throw new ValidationError(`The file is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`);
  }
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new ValidationError('The file is not a valid .xlsx workbook (bad ZIP signature).');
  }

  // End Of Central Directory record: scan backwards (it may be followed by a comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ValidationError('The file is not a valid .xlsx workbook (ZIP directory not found).');

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    throw new ValidationError('ZIP64 archives are not accepted.');
  }
  if (entryCount > MAX_ENTRIES) throw new ValidationError('The workbook contains too many internal files.');

  let p = cdOffset;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  const names: string[] = [];
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new ValidationError('The file is not a valid .xlsx workbook (corrupt ZIP directory).');
    }
    const compressed = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    totalUncompressed += uncompressed;
    totalCompressed += compressed;
    if (uncompressed === 0xffffffff || totalUncompressed > MAX_UNCOMPRESSED_TOTAL) {
      throw new ValidationError('The workbook expands to an unreasonable size and was rejected.');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (totalCompressed > 0 && totalUncompressed / totalCompressed > MAX_RATIO && totalUncompressed > 5 * 1024 * 1024) {
    throw new ValidationError('The workbook has a suspicious compression ratio and was rejected.');
  }

  for (const name of names) {
    if (name.includes('..')) throw new ValidationError('The workbook contains an unsafe internal path.');
    if (/vbaProject\.bin$/i.test(name)) {
      throw new ValidationError('Macro-enabled workbooks are not accepted. Save the file as a plain .xlsx.');
    }
    if (/^xl\/externalLinks\//i.test(name)) {
      throw new ValidationError('Workbooks with external links are not accepted. Break the links (Data > Edit Links) and re-save.');
    }
  }
}
