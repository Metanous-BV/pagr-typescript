import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PagrDecodeError } from '../errors.js';

/**
 * Narrows a decoded JSON payload to an object, throwing `PagrDecodeError` when
 * it is anything else (a bare string, an array, `null`). Guards the
 * `data as SomeWire` casts in every `fromApi` factory, so a wrong-shaped
 * response fails as a `PagrError` rather than as a later `undefined` access.
 */
export function asRecord(data: unknown, what: string): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new PagrDecodeError(`expected a JSON object for ${what}`);
  }
  return data as Record<string, unknown>;
}

/**
 * Returns `data[key]`, throwing `PagrDecodeError` when it is absent or `null`.
 *
 * Use for fields the wire format guarantees. Quietly defaulting them instead
 * (`?? ''`, `?? 0`) turns a truncated or malformed response into a model full
 * of empty strings and zeros that looks valid to the caller; this surfaces the
 * problem at the point of decoding, while keeping callers to the SDK's "only
 * ever catch `PagrError`" contract.
 *
 * The value is cast rather than type-checked: presence is the SDK's contract,
 * the wire types are the API's.
 */
export function requireField<T>(data: Record<string, unknown>, key: string): T {
  const value = data[key];
  if (value === undefined || value === null) {
    throw new PagrDecodeError(`response is missing required field '${key}'`);
  }
  return value as T;
}

/** Like {@link requireField}, for a timestamp the wire format guarantees. */
export function requireDate(data: Record<string, unknown>, key: string): Date {
  const parsed = parseDate(requireField<string>(data, key));
  if (parsed === null) {
    throw new PagrDecodeError(`response field '${key}' is not a valid timestamp`);
  }
  return parsed;
}

/** Reads an optional string field, mapping an absent or `null` value to `null`. */
export function optionalString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Parses an ISO-8601 timestamp. A value carrying an explicit offset
 * (including a trailing `Z`) is parsed as-is; an offset-less value is
 * assumed to be UTC, matching the convention used consistently across the
 * Pagr API. Returns `null` when the value is missing, blank, or cannot be
 * parsed either way.
 */
export function parseDate(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const date = new Date(hasOffset ? trimmed : `${trimmed}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Reduces a server-supplied document name to a bare, safe filename.
 *
 * `documentName` is data (it can embed values bound from the render payload),
 * not a path, so it must never be able to steer a `save` outside the target
 * directory. This strips any directory components (both `/` and `\`), a
 * Windows drive prefix (e.g. `C:`) and leading separators, and falls back to
 * a literal `'document'` for an empty/`.`/`..` result.
 */
export function safeFilename(name: string): string {
  // Drop directory components: normalise `\` to `/`, keep only the last segment.
  let result = name.replace(/\\/g, '/');
  const lastSlash = result.lastIndexOf('/');
  if (lastSlash !== -1) {
    result = result.slice(lastSlash + 1);
  }
  // Drop a Windows drive prefix (e.g. a drive-relative `C:name`).
  result = result.replace(/^[A-Za-z]:/, '');
  // Strip any leading separators and surrounding whitespace.
  result = result.replace(/^[/\\]+/, '').trim();
  if (result === '' || result === '.' || result === '..') {
    return 'document';
  }
  return result;
}

/**
 * Writes rendered/persisted-document bytes to disk. Returns the path
 * actually written.
 *
 * An existing directory is filled with `documentName` (falling back to `id`),
 * reduced to a safe single-segment filename via {@link safeFilename}, with
 * `.pdf` appended unless the name already ends in it. Anything else is treated
 * as an explicit destination file and written verbatim.
 *
 * The extension test is a case-insensitive `.pdf` suffix check rather than
 * "does this have any extension": a document name is generated from the
 * version's document-name template and routinely embeds bound values, so
 * `Invoice 2024.10` must still be saved as `Invoice 2024.10.pdf` — treating
 * `.10` as an existing extension would write an extensionless PDF.
 */
export async function saveDocumentBytes(
  destinationPath: string,
  documentName: string,
  id: string | null,
  bytes: Uint8Array,
): Promise<string> {
  const stats = await stat(destinationPath).catch(() => null);
  if (!stats?.isDirectory()) {
    await writeFile(destinationPath, bytes);
    return destinationPath;
  }
  const rawName = documentName.trim() !== '' ? documentName : (id ?? '');
  let filename = safeFilename(rawName);
  if (!filename.toLowerCase().endsWith('.pdf')) {
    filename += '.pdf';
  }
  const finalPath = join(destinationPath, filename);
  await writeFile(finalPath, bytes);
  return finalPath;
}
