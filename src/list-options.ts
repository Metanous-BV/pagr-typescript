import { validateFilter, type FilterTable } from './filters.js';
import type { QueryParams } from './http.js';

/** Comparison operator for a {@link Filter}. Defaults to `'eq'` on the wire. */
export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';

/**
 * A single field filter for a list endpoint, serialised to the API's indexed
 * model-binding query form (`filters[0].field=...&filters[0].op=...&filters[0].value=...`).
 */
export interface Filter {
  /** The field name to filter on. */
  field: string;
  /** The comparison operator. Defaults to `'eq'` when omitted. */
  op?: FilterOp;
  /** The value to compare against. */
  value: string;
}

/** Sort order for a list endpoint's `sortBy` field. */
export type SortDirection = 'asc' | 'desc';

/**
 * Paging, sorting, filtering and search options for list endpoints
 * (templates, versions, documents). Only the options you set are sent; an
 * empty/omitted options object sends no query at all. Use
 * {@link PagedResult.hasMore} on the returned page to drive `skip`/`take`
 * paging.
 */
export interface ListOptions {
  /** The number of items to skip (paging offset). */
  skip?: number;
  /** The page size. The server clamps this to 1-200. */
  take?: number;
  /** The field name to sort by. */
  sortBy?: string;
  /** The sort order. */
  sortDirection?: SortDirection;
  /** Field filters, serialised to the API's indexed `filters[i].field` form. */
  filters?: readonly Filter[];
  /** Free-text search. */
  search?: string;
}

/**
 * Builds the ordered query pairs for a `ListQuery`-bound endpoint; unset
 * options are omitted so the request carries only what was explicitly set.
 * Params are emitted in a fixed order: `skip`, `take`, `sortBy`,
 * `sortDirection`, `search`, then the indexed `filters[i]` triples.
 *
 * When `allowed` (the endpoint's table from `filters.ts`) is supplied, each
 * filter's field/operator is validated against it and an unknown combination
 * throws — the server would otherwise silently ignore it and return the
 * unfiltered result set. Called without a table, filters are serialized as-is
 * (used by low-level tests).
 */
export function buildListQuery(options?: ListOptions, allowed?: FilterTable): QueryParams {
  const query: [string, string][] = [];
  if (!options) {
    return query;
  }
  if (options.skip !== undefined) {
    query.push(['skip', String(options.skip)]);
  }
  if (options.take !== undefined) {
    query.push(['take', String(options.take)]);
  }
  if (options.sortBy !== undefined) {
    query.push(['sortBy', options.sortBy]);
  }
  if (options.sortDirection !== undefined) {
    query.push(['sortDirection', options.sortDirection]);
  }
  if (options.search !== undefined) {
    query.push(['search', options.search]);
  }
  const filters = options.filters ?? [];
  filters.forEach((filter, i) => {
    const op = filter.op ?? 'eq';
    if (allowed !== undefined) {
      validateFilter(i, filter.field, op, allowed);
    }
    query.push([`filters[${i}].field`, filter.field]);
    query.push([`filters[${i}].op`, op]);
    query.push([`filters[${i}].value`, filter.value]);
  });
  return query;
}
