import type { FilterOp } from './list-options.js';

/**
 * Canonical per-endpoint filter field/operator tables.
 *
 * This module is the authoritative TypeScript source for which fields each
 * list endpoint can be filtered on and, per field, which operators are valid.
 *
 * Why validate client-side at all? The server **silently ignores** an unknown
 * filter field or operator and returns the *unfiltered* result set — so a typo
 * (`'documentNam'` for `'documentName'`) would not error, it would silently
 * return everything. Rejecting unknown fields/operators here turns that silent,
 * data-wrong outcome into an immediate, obvious `Error`.
 *
 * Field names are the API's camelCase wire names (matching the `sortBy` /
 * docstring tables in `client.ts`).
 */

/** A table of allowed operators per filter field for one endpoint. */
export type FilterTable = Readonly<Record<string, readonly FilterOp[]>>;

// Operator sets, reused across fields of the same kind.
const EQ: readonly FilterOp[] = ['eq']; // exact match only (ids/guids)
const STRING: readonly FilterOp[] = ['eq', 'contains']; // text fields
const ORD: readonly FilterOp[] = ['eq', 'gt', 'gte', 'lt', 'lte']; // numbers and datetimes
const ENUM: readonly FilterOp[] = ['eq', 'neq']; // closed-vocabulary fields

/** Filters accepted by `getTemplates` / project-scoped template listing. */
export const TEMPLATE_FILTERS: FilterTable = {
  name: STRING,
  'project.guid': EQ,
  createdAt: ORD,
  updatedAt: ORD,
};

/** Filters accepted by `getTemplateVersions`. */
export const TEMPLATE_VERSION_FILTERS: FilterTable = {
  versionNumber: ORD,
  publishedAt: ORD,
  createdAt: ORD,
  updatedAt: ORD,
};

/**
 * Filters accepted by `getDocuments`. Note `renderDuration` can be sorted on
 * but not filtered, and `documentType` supports neither — so neither appears
 * here.
 */
export const DOCUMENT_FILTERS: FilterTable = {
  documentName: STRING,
  'template.guid': EQ,
  versionNumber: ORD,
  fileSizeBytes: ORD,
  pageCount: ORD,
  renderedAt: ORD,
  createdAt: ORD,
  updatedAt: ORD,
  environment: ENUM,
  language: ENUM,
};

/**
 * Throws an `Error` if `field`/`op` are not valid for the given endpoint table.
 *
 * The server would otherwise silently ignore an unknown field/operator and
 * return the unfiltered result set, so this fails loudly client-side instead.
 *
 * @param index The filter's position in the caller's list (for the message).
 * @param field The requested filter field (camelCase wire name).
 * @param op The requested operator.
 * @param allowed The endpoint's `{field: [op, ...]}` table from this module.
 */
export function validateFilter(
  index: number,
  field: string,
  op: FilterOp,
  allowed: FilterTable,
): void {
  const allowedOps = allowed[field];
  if (allowedOps === undefined) {
    throw new Error(
      `filters[${index}]: unknown field '${field}' for this endpoint; ` +
        `allowed fields: ${Object.keys(allowed).sort().join(', ')}`,
    );
  }
  if (!allowedOps.includes(op)) {
    throw new Error(
      `filters[${index}]: operator '${op}' is not valid for field '${field}'; ` +
        `allowed operators: ${allowedOps.join(', ')}`,
    );
  }
}
