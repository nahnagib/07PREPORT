import { inflateRawSync } from 'node:zlib';

/**
 * Reads one entry of a ZIP archive (a .docx / .xlsx is one) with Node's own zlib: the end-of-central-directory
 * record -> the central directory -> the entry's local header -> stored or deflated data. Enough for Office files;
 * no ZIP64, no encryption. Returns null when the entry is not there.
 */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a ZIP file.');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken ZIP central directory.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Broken ZIP local header.');
      const lName = buf.readUInt16LE(localOffset + 26);
      const lExtra = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lName + lExtra;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported ZIP compression method ${method}.`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Entry names (used to tell a .docx from an .xlsx by content, not by its extension). */
export function zipEntryNames(buf: Buffer): string[] {
  const eocd = findEocd(buf);
  if (eocd < 0) return [];
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: string[] = [];
  for (let i = 0; i < entries && p + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    out.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}
