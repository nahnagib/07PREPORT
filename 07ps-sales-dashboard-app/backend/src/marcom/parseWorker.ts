import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { parseMarcomWorkbook, TemplateStructureError, type ParseOptions } from './parser';
import { ValidationError } from '../lib/errors';

/** Runs one workbook parse off the request thread (see parseRunner.ts). Posts a single message. */
(async () => {
  const { filePath, filename, opts } = workerData as { filePath: string; filename: string; opts: ParseOptions };
  try {
    const buf = fs.readFileSync(filePath);
    const result = await parseMarcomWorkbook(buf, filename, opts);
    parentPort!.postMessage({ ok: true, result });
  } catch (err) {
    parentPort!.postMessage({
      ok: false,
      expected: err instanceof ValidationError,
      message: err instanceof Error ? err.message : String(err),
      problems: err instanceof TemplateStructureError ? err.problems : undefined,
    });
  }
})();
