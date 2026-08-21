import { parseDate } from './_common.js';

/**
 * Parses a JSON-object string into a plain object, returning `{}` for an
 * empty, missing or unparseable value — kept lenient so a malformed
 * server-sent string never throws a raw `SyntaxError`.
 */
function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface TemplateWire {
  id?: string;
  name?: string;
  documentNameTemplate?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  latestVersionNumber?: number | null;
  versionCount?: number;
  updatedAt?: string | null;
  updatedBy?: string | null;
  masterTemplateId?: string | null;
  masterTemplateName?: string | null;
}

/**
 * A document template as listed by the API. Carries the template's identity
 * and catalogue metadata (project, latest version number, audit fields). The
 * actual template content lives on its versions — fetch one with
 * `getTemplateVersion`.
 */
export class Template {
  readonly id: string;
  readonly name: string;
  readonly documentNameTemplate: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly latestVersionNumber: number | null;
  readonly versionCount: number;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
  readonly masterTemplateId: string | null;
  readonly masterTemplateName: string | null;

  private constructor(wire: TemplateWire) {
    this.id = wire.id ?? '';
    this.name = wire.name ?? '';
    this.documentNameTemplate = wire.documentNameTemplate ?? null;
    this.projectId = wire.projectId ?? null;
    this.projectName = wire.projectName ?? null;
    this.latestVersionNumber = wire.latestVersionNumber ?? null;
    this.versionCount = wire.versionCount ?? 0;
    this.updatedAt = parseDate(wire.updatedAt);
    this.updatedBy = wire.updatedBy ?? null;
    this.masterTemplateId = wire.masterTemplateId ?? null;
    this.masterTemplateName = wire.masterTemplateName ?? null;
  }

  static fromApi(data: unknown): Template {
    return new Template(data as TemplateWire);
  }

  toString(): string {
    return `${this.name} (${this.id})`;
  }
}

interface TemplateVersionWire {
  id?: string;
  versionNumber?: number;
  templateJson?: string;
  sampleData?: string;
  documentNameTemplate?: string | null;
  publishedAt?: string | null;
  publishedBy?: string | null;
  templateId?: string;
  updatedAt?: string | null;
  translations?: string | null;
}

/**
 * A single version of a template. `templateJson` is the template DSL as a
 * raw JSON string (there is no typed model for it yet). `sampleData` is
 * parsed into a plain object — it matches the version's bindings and can be
 * passed directly to `render`/`validate` as a starting point for your own
 * document data. `translations` is a raw JSON string, or `null` when the
 * version has none.
 */
export class TemplateVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly templateJson: string;
  readonly sampleData: Record<string, unknown>;
  readonly documentNameTemplate: string | null;
  readonly publishedAt: Date | null;
  readonly publishedBy: string | null;
  readonly templateId: string;
  readonly updatedAt: Date | null;
  readonly translations: string | null;

  private constructor(wire: TemplateVersionWire) {
    this.id = wire.id ?? '';
    this.versionNumber = wire.versionNumber ?? 0;
    this.templateJson = wire.templateJson ?? '';
    this.sampleData = parseJsonObject(wire.sampleData);
    this.documentNameTemplate = wire.documentNameTemplate ?? null;
    this.publishedAt = parseDate(wire.publishedAt);
    this.publishedBy = wire.publishedBy ?? null;
    this.templateId = wire.templateId ?? '';
    this.updatedAt = parseDate(wire.updatedAt);
    this.translations = wire.translations ?? null;
  }

  static fromApi(data: unknown): TemplateVersion {
    return new TemplateVersion(data as TemplateVersionWire);
  }

  toString(): string {
    return `v${this.versionNumber} (${this.id})`;
  }
}
