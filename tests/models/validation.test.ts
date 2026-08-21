import { describe, expect, it } from 'vitest';
import { ValidationResponse } from '../../src/models/validation.js';

function issue(severity: string, documentIndex: number | null = null) {
  return { type: 'SchemaInvalid', severity, description: 'bad field', documentIndex };
}

describe('ValidationResponse', () => {
  it('isValid is true when there are no issues', () => {
    const response = ValidationResponse.fromApi({ issues: [] });
    expect(response.isValid).toBe(true);
    expect(response.errors).toEqual([]);
  });

  it('isValid is false when any issue has Error severity', () => {
    const response = ValidationResponse.fromApi({ issues: [issue('Warning'), issue('Error')] });
    expect(response.isValid).toBe(false);
    expect(response.errors).toHaveLength(1);
    expect(response.warnings).toHaveLength(1);
  });

  it('isValid is false when the only issue is Warning severity (the production gate)', () => {
    const response = ValidationResponse.fromApi({ issues: [issue('Warning')] });
    expect(response.isValid).toBe(false);
    expect(response.errors).toHaveLength(0);
    expect(response.warnings).toHaveLength(1);
  });

  it('isValid is true when the only issue is Information severity', () => {
    const response = ValidationResponse.fromApi({ issues: [issue('Information')] });
    expect(response.isValid).toBe(true);
  });

  it('issuesFor includes batch-wide issues (documentIndex null) plus issues for that index', () => {
    const response = ValidationResponse.fromApi({
      issues: [issue('Error', 0), issue('Warning', 1), issue('Information', null)],
    });
    expect(response.issuesFor(0)).toHaveLength(2);
    expect(response.issuesFor(1)).toHaveLength(2);
    expect(response.issuesFor(2)).toHaveLength(1);
  });

  it('is iterable over its issues', () => {
    const response = ValidationResponse.fromApi({ issues: [issue('Error')] });
    expect([...response]).toHaveLength(1);
  });
});
