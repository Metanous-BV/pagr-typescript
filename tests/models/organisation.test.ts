import { describe, expect, it } from 'vitest';
import { OrgStats } from '../../src/models/organisation.js';

describe('OrgStats', () => {
  it('parses all fields', () => {
    const stats = OrgStats.fromApi({
      organisationName: 'Acme',
      periodStart: '2024-01-01T00:00:00Z',
      periodEnd: '2024-02-01T00:00:00Z',
      tier: 'pro',
      includedRendersPerMonth: 1000,
      pagesUsedThisPeriod: 250,
      pagesAvailable: 750,
      includedTokensPerMonth: 5000,
      tokensUsedThisPeriod: 100,
      tokensAvailable: 4900,
      userCount: 4,
    });
    expect(stats.organisationName).toBe('Acme');
    expect(stats.tier).toBe('pro');
    expect(stats.pagesAvailable).toBe(750);
    expect(stats.periodStart?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('leaves every absent field null, counts included', () => {
    // An omitted count stays null rather than collapsing to 0, so the caller can
    // tell "the server did not report this" from "the server reported zero".
    const stats = OrgStats.fromApi({});
    expect(stats.organisationName).toBeNull();
    expect(stats.periodStart).toBeNull();
    expect(stats.includedRendersPerMonth).toBeNull();
    expect(stats.pagesUsedThisPeriod).toBeNull();
    expect(stats.pagesAvailable).toBeNull();
    expect(stats.includedTokensPerMonth).toBeNull();
    expect(stats.tokensUsedThisPeriod).toBeNull();
    expect(stats.tokensAvailable).toBeNull();
    expect(stats.userCount).toBeNull();
  });

  it('keeps a genuine zero distinct from an absent count', () => {
    const stats = OrgStats.fromApi({ pagesUsedThisPeriod: 0, pagesAvailable: null });
    expect(stats.pagesUsedThisPeriod).toBe(0);
    expect(stats.pagesAvailable).toBeNull();
  });

  it('toString renders a multi-line summary', () => {
    const stats = OrgStats.fromApi({ organisationName: 'Acme', tier: 'pro' });
    expect(stats.toString()).toContain('Acme (pro)');
  });
});
