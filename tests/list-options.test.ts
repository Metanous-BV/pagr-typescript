import { describe, expect, it } from 'vitest';
import { DOCUMENT_FILTERS, TEMPLATE_FILTERS } from '../src/filters.js';
import { buildListQuery, type Filter } from '../src/list-options.js';

describe('buildListQuery', () => {
  it('returns an empty array when options are omitted', () => {
    expect(buildListQuery()).toEqual([]);
  });

  it('returns an empty array when options are all unset', () => {
    expect(buildListQuery({})).toEqual([]);
  });

  it('omits unset fields entirely, in the canonical order', () => {
    expect(buildListQuery({ take: 50 })).toEqual([['take', '50']]);
  });

  it('serialises every field in order: skip, take, sortBy, sortDirection, search', () => {
    expect(
      buildListQuery({
        skip: 10,
        take: 50,
        sortBy: 'updatedAt',
        sortDirection: 'desc',
        search: 'invoice',
      }),
    ).toEqual([
      ['skip', '10'],
      ['take', '50'],
      ['sortBy', 'updatedAt'],
      ['sortDirection', 'desc'],
      ['search', 'invoice'],
    ]);
  });

  it('appends indexed filter triples after the scalar fields, defaulting op to eq', () => {
    const filters: Filter[] = [
      { field: 'name', op: 'contains', value: 'invoice' },
      { field: 'archived', value: 'false' },
    ];
    expect(buildListQuery({ take: 50, filters })).toEqual([
      ['take', '50'],
      ['filters[0].field', 'name'],
      ['filters[0].op', 'contains'],
      ['filters[0].value', 'invoice'],
      ['filters[1].field', 'archived'],
      ['filters[1].op', 'eq'],
      ['filters[1].value', 'false'],
    ]);
  });

  it('treats skip:0/take:0 as explicitly set (not omitted)', () => {
    expect(buildListQuery({ skip: 0, take: 0 })).toEqual([
      ['skip', '0'],
      ['take', '0'],
    ]);
  });
});

describe('buildListQuery filter validation', () => {
  it('throws on an unknown field when a table is supplied', () => {
    expect(() =>
      buildListQuery({ filters: [{ field: 'documentNam', value: 'x' }] }, DOCUMENT_FILTERS),
    ).toThrow(/unknown field 'documentNam'/);
  });

  it('throws on an operator not allowed for the field', () => {
    expect(() =>
      buildListQuery({ filters: [{ field: 'name', op: 'gt', value: 'x' }] }, TEMPLATE_FILTERS),
    ).toThrow(/operator 'gt' is not valid/);
  });

  it('passes a valid field/op combination through', () => {
    expect(
      buildListQuery(
        { filters: [{ field: 'name', op: 'contains', value: 'inv' }] },
        TEMPLATE_FILTERS,
      ),
    ).toEqual([
      ['filters[0].field', 'name'],
      ['filters[0].op', 'contains'],
      ['filters[0].value', 'inv'],
    ]);
  });

  it('skips validation entirely when no table is supplied (low-level use)', () => {
    expect(() => buildListQuery({ filters: [{ field: 'anything', value: 'x' }] })).not.toThrow();
  });
});
