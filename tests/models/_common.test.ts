import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDate, safeFilename, saveDocumentBytes } from '../../src/models/_common.js';

describe('parseDate', () => {
  it('treats an offset-less timestamp as UTC, not local time', () => {
    // process.env.TZ is pinned to a non-UTC zone in tests/setup-timezone.ts —
    // if this were parsed as local time the epoch would be off by the zone offset.
    const withZ = parseDate('2024-01-01T12:00:00Z');
    const withoutOffset = parseDate('2024-01-01T12:00:00');
    expect(withoutOffset?.getTime()).toBe(withZ?.getTime());
  });

  it('parses an explicit positive/negative offset as-is', () => {
    const utc = parseDate('2024-01-01T12:00:00Z')!;
    const negativeOffset = parseDate('2024-01-01T07:00:00-05:00')!;
    const positiveOffset = parseDate('2024-01-01T14:00:00+02:00')!;
    expect(negativeOffset.getTime()).toBe(utc.getTime());
    expect(positiveOffset.getTime()).toBe(utc.getTime());
  });

  it('handles fractional seconds', () => {
    const date = parseDate('2024-01-01T12:00:00.123456Z');
    expect(date?.getTime()).toBe(Date.UTC(2024, 0, 1, 12, 0, 0, 123));
  });

  it('returns null for null, undefined, blank, or unparsable values', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('   ')).toBeNull();
    expect(parseDate('not-a-date')).toBeNull();
  });
});

describe('saveDocumentBytes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pagr-sdk-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes directly to an explicit file path', async () => {
    const target = join(dir, 'invoice.pdf');
    const written = await saveDocumentBytes(target, 'Invoice', 'doc-1', Buffer.from('%PDF-1.7'));
    expect(written).toBe(target);
    expect((await readFile(target)).toString()).toBe('%PDF-1.7');
  });

  it('uses documentName as the filename when given a directory', async () => {
    const written = await saveDocumentBytes(dir, 'Invoice', 'doc-1', Buffer.from('%PDF-1.7'));
    expect(written).toBe(join(dir, 'Invoice.pdf'));
  });

  it('falls back to id when documentName is blank', async () => {
    const written = await saveDocumentBytes(dir, '', 'doc-1', Buffer.from('%PDF-1.7'));
    expect(written).toBe(join(dir, 'doc-1.pdf'));
  });

  it('does not double up an extension the name already carries', async () => {
    const written = await saveDocumentBytes(dir, 'invoice.pdf', 'doc-1', Buffer.from('%PDF-1.7'));
    expect(written).toBe(join(dir, 'invoice.pdf'));
  });

  it('treats an existing .pdf extension case-insensitively', async () => {
    const written = await saveDocumentBytes(dir, 'Invoice.PDF', 'doc-1', Buffer.from('%PDF-1.7'));
    expect(written).toBe(join(dir, 'Invoice.PDF'));
  });

  it('appends .pdf to a name whose trailing segment only looks like an extension', async () => {
    // Document names are generated from a template and routinely embed bound
    // values, so '.10' / '.2' are data, not extensions.
    for (const [name, expected] of [
      ['Invoice 2024.10', 'Invoice 2024.10.pdf'],
      ['Report v1.2', 'Report v1.2.pdf'],
      ['ACME Corp. Report', 'ACME Corp. Report.pdf'],
    ] as const) {
      const written = await saveDocumentBytes(dir, name, 'doc-1', Buffer.from('%PDF-1.7'));
      expect(written, name).toBe(join(dir, expected));
    }
  });

  it('honours an explicit file path verbatim, without forcing an extension', async () => {
    const target = join(dir, 'no-extension');
    const written = await saveDocumentBytes(target, 'Invoice', 'doc-1', Buffer.from('%PDF-1.7'));
    expect(written).toBe(target);
    expect((await readFile(target)).toString()).toBe('%PDF-1.7');
  });

  it('falls back to "document" when both documentName and id are empty', async () => {
    const written = await saveDocumentBytes(dir, '', null, Buffer.from('%PDF-1.7'));
    expect(written).toBe(join(dir, 'document.pdf'));
  });

  it('sanitizes a traversal document name so the write stays inside the directory', async () => {
    const written = await saveDocumentBytes(dir, '../../evil', 'doc-1', Buffer.from('%PDF-1.7'));
    expect(written).toBe(join(dir, 'evil.pdf'));
    expect(await readFile(written)).toBeDefined();
  });
});

describe('safeFilename', () => {
  it('strips directory components (both separators)', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('a/b/c.pdf')).toBe('c.pdf');
    expect(safeFilename('a\\b\\c.pdf')).toBe('c.pdf');
  });

  it('strips a Windows drive prefix', () => {
    expect(safeFilename('C:evil.pdf')).toBe('evil.pdf');
    expect(safeFilename('C:\\Windows\\evil.pdf')).toBe('evil.pdf');
  });

  it('falls back to "document" for empty/./.. results', () => {
    expect(safeFilename('')).toBe('document');
    expect(safeFilename('.')).toBe('document');
    expect(safeFilename('..')).toBe('document');
    expect(safeFilename('/')).toBe('document');
  });

  it('keeps a normal name unchanged', () => {
    expect(safeFilename('Invoice 42')).toBe('Invoice 42');
  });
});
