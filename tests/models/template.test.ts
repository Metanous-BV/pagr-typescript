import { describe, expect, it } from 'vitest';
import { Template, TemplateVersion } from '../../src/models/template.js';

describe('Template', () => {
  it('parses all fields with UUID-shaped strings preserved as plain strings', () => {
    const template = Template.fromApi({
      id: 'tmpl-1',
      name: 'Invoice',
      documentNameTemplate: 'Invoice {{number}}',
      projectId: 'proj-1',
      projectName: 'Billing',
      latestVersionNumber: 3,
      versionCount: 5,
      updatedAt: '2024-01-01T00:00:00Z',
      updatedBy: 'alice',
      masterTemplateId: null,
      masterTemplateName: null,
    });
    expect(template.id).toBe('tmpl-1');
    expect(template.name).toBe('Invoice');
    expect(template.latestVersionNumber).toBe(3);
    expect(template.versionCount).toBe(5);
    expect(template.updatedAt?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(template.masterTemplateId).toBeNull();
  });

  it('defaults optional fields sensibly when absent', () => {
    const template = Template.fromApi({ id: 'tmpl-1', name: 'Invoice' });
    expect(template.versionCount).toBe(0);
    expect(template.projectId).toBeNull();
    expect(template.updatedAt).toBeNull();
  });

  it('toString renders name and id', () => {
    const template = Template.fromApi({ id: 'tmpl-1', name: 'Invoice' });
    expect(template.toString()).toBe('Invoice (tmpl-1)');
  });
});

describe('TemplateVersion', () => {
  it('keeps templateJson/translations raw but parses sampleData into an object', () => {
    const version = TemplateVersion.fromApi({
      id: 'ver-1',
      versionNumber: 2,
      templateJson: '{"elements":[]}',
      sampleData: '{"Title":"Hello"}',
      documentNameTemplate: null,
      publishedAt: '2024-01-01T00:00:00Z',
      publishedBy: 'bob',
      templateId: 'tmpl-1',
      updatedAt: '2024-01-02T00:00:00Z',
      translations: '{"nl":{"Title":"Hallo"}}',
    });
    expect(typeof version.templateJson).toBe('string');
    // sampleData is parsed from its JSON string into an object (matches Python).
    expect(version.sampleData).toEqual({ Title: 'Hello' });
    expect(version.translations).toBe('{"nl":{"Title":"Hallo"}}');
    expect(version.publishedAt?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('translations defaults to null and sampleData to {} when absent', () => {
    const version = TemplateVersion.fromApi({ id: 'ver-1', templateId: 'tmpl-1' });
    expect(version.translations).toBeNull();
    expect(version.sampleData).toEqual({});
  });

  it('toString renders version number and id', () => {
    const version = TemplateVersion.fromApi({ id: 'ver-1', versionNumber: 4 });
    expect(version.toString()).toBe('v4 (ver-1)');
  });
});
