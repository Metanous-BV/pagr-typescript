import { parseDate } from './_common.js';

interface OrgStatsWire {
  organisationName?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  tier?: string | null;
  includedRendersPerMonth?: number | null;
  pagesUsedThisPeriod?: number | null;
  pagesAvailable?: number | null;
  includedTokensPerMonth?: number | null;
  tokensUsedThisPeriod?: number | null;
  tokensAvailable?: number | null;
  userCount?: number | null;
}

/**
 * Usage and credit statistics for the authenticated organisation, covering
 * the current billing period (`periodStart`–`periodEnd`).
 *
 * "Pages" is the render-credit unit (rendered document pages); "tokens" are
 * AI tokens consumed by AI-assisted template features. Each has an included
 * monthly allowance, an amount used this period, and an amount remaining.
 *
 * A value of `-1` in `pagesAvailable`, `includedTokensPerMonth` or
 * `tokensAvailable` means unlimited for the organisation's `tier` — guard
 * against it before doing arithmetic on these fields.
 *
 * Every count is `number | null`: a field the server omits stays `null` rather
 * than collapsing to `0`, so an absent field is distinguishable from a genuine
 * zero. Null-check before arithmetic.
 */
export class OrgStats {
  readonly organisationName: string | null;
  /** Start of the current billing period. */
  readonly periodStart: Date | null;
  /** End of the current billing period. */
  readonly periodEnd: Date | null;
  /** The organisation's subscription tier. */
  readonly tier: string | null;
  /** Included page (render) allowance per month; `null` if the server omitted it. */
  readonly includedRendersPerMonth: number | null;
  /** Pages rendered so far this period; `null` if the server omitted it. */
  readonly pagesUsedThisPeriod: number | null;
  /** Pages remaining this period; `-1` means unlimited, `null` means absent. */
  readonly pagesAvailable: number | null;
  /** Included AI-token allowance per month; `-1` means unlimited, `null` means absent. */
  readonly includedTokensPerMonth: number | null;
  /** AI tokens consumed so far this period; `null` if the server omitted it. */
  readonly tokensUsedThisPeriod: number | null;
  /** AI tokens remaining this period; `-1` means unlimited, `null` means absent. */
  readonly tokensAvailable: number | null;
  /** Number of users in the organisation; `null` if the server omitted it. */
  readonly userCount: number | null;

  private constructor(wire: OrgStatsWire) {
    this.organisationName = wire.organisationName ?? null;
    this.periodStart = parseDate(wire.periodStart);
    this.periodEnd = parseDate(wire.periodEnd);
    this.tier = wire.tier ?? null;
    this.includedRendersPerMonth = wire.includedRendersPerMonth ?? null;
    this.pagesUsedThisPeriod = wire.pagesUsedThisPeriod ?? null;
    this.pagesAvailable = wire.pagesAvailable ?? null;
    this.includedTokensPerMonth = wire.includedTokensPerMonth ?? null;
    this.tokensUsedThisPeriod = wire.tokensUsedThisPeriod ?? null;
    this.tokensAvailable = wire.tokensAvailable ?? null;
    this.userCount = wire.userCount ?? null;
  }

  static fromApi(data: unknown): OrgStats {
    return new OrgStats(data as OrgStatsWire);
  }

  toString(): string {
    const period =
      this.periodStart && this.periodEnd
        ? `${this.periodStart.toISOString().slice(0, 10)} → ${this.periodEnd.toISOString().slice(0, 10)}`
        : '—';
    return [
      `OrgStats | ${this.organisationName ?? '?'} (${this.tier})`,
      `  Period:  ${period}`,
      `  Pages:   ${this.pagesUsedThisPeriod} used / ${this.includedRendersPerMonth} included / ${this.pagesAvailable} remaining`,
      `  Tokens:  ${this.tokensUsedThisPeriod} used / ${this.includedTokensPerMonth} included / ${this.tokensAvailable} remaining`,
      `  Users:   ${this.userCount}`,
    ].join('\n');
  }
}
