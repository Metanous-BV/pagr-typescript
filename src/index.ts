export { DEFAULT_BASE_URL, DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS, PagrApiClient } from './client.js';
export type { DocumentInput, RenderOptions } from './client.js';

export {
  ApiError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  PagrConnectionError,
  PagrDecodeError,
  PagrError,
  PagrSignatureError,
  PagrTimeoutError,
  PayloadTooLargeError,
  RateLimitError,
  ValidationFailedError,
} from './errors.js';

export { buildListQuery } from './list-options.js';
export type { Filter, FilterOp, ListOptions, SortDirection } from './list-options.js';
export {
  DOCUMENT_FILTERS,
  TEMPLATE_FILTERS,
  TEMPLATE_VERSION_FILTERS,
  validateFilter,
} from './filters.js';
export type { FilterTable } from './filters.js';

export {
  BatchItem,
  BatchRenderResult,
  OrgStats,
  PagedResult,
  PdfDocument,
  PdfRenderResult,
  RenderDocument,
  RenderIssue,
  RenderJob,
  RenderJobStatus,
  RenderResult,
  RenderedDocument,
  Template,
  TemplateVersion,
  ValidationResponse,
  isRenderJobStateTerminal,
  isRenderIssueSeverityAtLeast,
  isRenderIssueSeverityBlockingProduction,
  parseRenderIssueSeverity,
  parseRenderIssueType,
  parseRenderJobState,
  parseRenderOutcome,
} from './models/index.js';
export type {
  RenderIssueSeverity,
  RenderIssueType,
  RenderJobState,
  RenderOutcome,
} from './models/index.js';

export {
  DEFAULT_SIGNATURE_TOLERANCE_MS,
  DELIVERY_HEADER,
  EVENT_HEADER,
  RenderCompletion,
  RenderProgress,
  SIGNATURE_HEADER,
  parseCallback,
  parseSignedCallback,
  verifySignature,
} from './webhook.js';
export type { VerifySignatureOptions } from './webhook.js';

export const version = '0.1.0';
