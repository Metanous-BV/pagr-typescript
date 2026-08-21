import { RenderIssue, isRenderIssueSeverityBlockingProduction } from './render.js';

interface ValidationApiResponseWire {
  issues?: unknown[];
}

/**
 * Validation results for a batch of documents. The API returns a single
 * flat list of {@link RenderIssue}s; each issue carries the `documentIndex`
 * of the document it pertains to (`null` for batch-wide issues). `isValid`
 * is the production gate: it is `true` only when no issue is blocking
 * production (i.e. `'Warning'` or `'Error'` severity). Callers who want the
 * narrower, Error-only check should inspect {@link errors} directly
 * instead. Iterable over the issues.
 */
export class ValidationResponse implements Iterable<RenderIssue> {
  /** All issues reported for the submitted documents. */
  readonly issues: readonly RenderIssue[];

  private constructor(issues: readonly RenderIssue[]) {
    this.issues = issues;
  }

  static fromApi(data: unknown): ValidationResponse {
    const wire = data as ValidationApiResponseWire;
    return new ValidationResponse((wire.issues ?? []).map(RenderIssue.fromApi));
  }

  /**
   * `true` when no issue is `'Warning'` or `'Error'` severity (i.e. no
   * issue blocks a production render). For the narrower, Error-only check,
   * use {@link errors} directly.
   */
  get isValid(): boolean {
    return !this.issues.some((issue) => isRenderIssueSeverityBlockingProduction(issue.severity));
  }

  /** The issues of `'Error'` severity. */
  get errors(): readonly RenderIssue[] {
    return this.issues.filter((issue) => issue.severity === 'Error');
  }

  /** The issues of `'Warning'` severity. */
  get warnings(): readonly RenderIssue[] {
    return this.issues.filter((issue) => issue.severity === 'Warning');
  }

  /**
   * The issues pertaining to a specific document, including batch-wide
   * issues (those whose `documentIndex` is `null`).
   */
  issuesFor(documentIndex: number): readonly RenderIssue[] {
    return this.issues.filter(
      (issue) => issue.documentIndex === null || issue.documentIndex === documentIndex,
    );
  }

  [Symbol.iterator](): Iterator<RenderIssue> {
    return this.issues[Symbol.iterator]();
  }

  toString(): string {
    const header = this.isValid
      ? 'valid'
      : `${this.errors.length} error(s), ${this.warnings.length} warning(s)`;
    if (this.issues.length === 0) {
      return `ValidationResponse (${header})`;
    }
    const body = this.issues.map((issue) => `  ${issue.toString()}`).join('\n');
    return `ValidationResponse (${header})\n${body}`;
  }
}
