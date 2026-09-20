import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ValidationError } from '../lib/errors';
import { parseMarcomWorkbook, TemplateStructureError, type ParseOptions, type ParseResult } from './parser';

const PARSE_TIMEOUT_MS = () => Number(process.env.MARCOM_PARSE_TIMEOUT_MS ?? 30_000);
/** Vitest can't load a .ts worker file, so tests parse in-process (the timeout still applies). */
const INLINE = () => process.env.MARCOM_PARSE_INLINE === '1' || !!process.env.VITEST;

export class ParseTimeoutError extends ValidationError {}

/** Rejects with ParseTimeoutError if `p` hasn't settled after `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.();
      reject(new ParseTimeoutError('Processing the workbook took too long and was cancelled. Try a smaller file.'));
    }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Parses a staged workbook without blocking the request event loop: in a worker thread (killed on
 * timeout) in normal operation, in-process under tests. The caller must already have passed the
 * file through assertSafeXlsx -- the parser re-checks anyway before exceljs loads anything.
 */
export async function runParse(filePath: string, filename: string, opts: ParseOptions & { knownBrands?: string[]; knownCampaigns?: string[] }): Promise<ParseResult> {
  const timeoutMs = PARSE_TIMEOUT_MS();
  if (INLINE()) {
    return withTimeout(parseMarcomWorkbook(fs.readFileSync(filePath), filename, opts), timeoutMs);
  }

  const ext = path.extname(__filename); // '.ts' under tsx, '.js' when compiled
  const worker = new Worker(path.join(__dirname, `parseWorker${ext}`), {
    workerData: { filePath, filename, opts: { ...opts, knownBrands: [...(opts.knownBrands ?? [])], knownCampaigns: [...(opts.knownCampaigns ?? [])] } },
    resourceLimits: { maxOldGenerationSizeMb: 768 },
  });
  const done = new Promise<ParseResult>((resolve, reject) => {
    worker.once('message', (m: { ok: boolean; result?: ParseResult; message?: string; problems?: string[]; expected?: boolean }) => {
      if (m.ok) resolve(m.result!);
      else if (m.problems) reject(new TemplateStructureError(m.problems));
      else if (m.expected) reject(new ValidationError(m.message ?? 'Invalid file.'));
      else reject(new Error(m.message));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`parse worker exited with code ${code}`)); });
  });
  try {
    return await withTimeout(done, timeoutMs, () => { void worker.terminate(); });
  } finally {
    void worker.terminate();
  }
}
