// services/bff/__tests__/workflows_templates.test.ts

import {
  ALL_WORKFLOW_DOMAINS,
  isWorkflowDomain,
  listWorkflowTemplates,
  getWorkflowTemplate,
  createWorkflowTemplate,
  updateWorkflowTemplate,
  deleteWorkflowTemplate,
  cloneWorkflowTemplate,
  _resetWorkflowTemplateStore,
  WorkflowTemplateError,
} from '../src/workflows_templates';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetWorkflowTemplateStore());

const sampleSteps = [
  { step_order: 1, name: 'Initial review', description: '', required_role: 'analyst', expected_duration_hours: 24, optional: false },
  { step_order: 2, name: 'Supervisor approval', description: '', required_role: 'supervisor', expected_duration_hours: 12, optional: false },
  { step_order: 3, name: 'Notify customer', description: '', required_role: 'analyst', expected_duration_hours: 4, optional: true },
];

describe('enums', () => {
  it('7 domain values', () => {
    expect(ALL_WORKFLOW_DOMAINS).toHaveLength(7);
    expect(isWorkflowDomain('borrower_escalation')).toBe(true);
    expect(isWorkflowDomain('bogus')).toBe(false);
  });
});

describe('CRUD', () => {
  it('create + list + get', () => {
    const t = createWorkflowTemplate(
      'BANK_DEMO',
      { name: 'Borrower Escalation Std', domain: 'borrower_escalation', steps: sampleSteps },
      'alice',
      NOW,
    );
    expect(t.template_id).toMatch(/^wft-BANK_DEMO-\d+$/);
    expect(t.steps).toHaveLength(3);
    expect(t.is_default).toBe(false);
    expect(listWorkflowTemplates('BANK_DEMO')).toHaveLength(1);
    expect(getWorkflowTemplate('BANK_DEMO', t.template_id)).not.toBeNull();
  });

  it('list filters by domain', () => {
    createWorkflowTemplate('BANK_DEMO', { name: 'AlphaWF', domain: 'borrower_escalation', steps: sampleSteps }, 'alice', NOW);
    createWorkflowTemplate('BANK_DEMO', { name: 'BetaWF', domain: 'kyc_onboarding', steps: sampleSteps }, 'alice', NOW);
    expect(listWorkflowTemplates('BANK_DEMO', 'kyc_onboarding')).toHaveLength(1);
    expect(listWorkflowTemplates('BANK_DEMO')).toHaveLength(2);
  });

  it('cross-tenant get/delete are null/false', () => {
    const t = createWorkflowTemplate('BANK_DEMO', { name: 'XyzWF', domain: 'recovery', steps: sampleSteps }, 'a', NOW);
    expect(getWorkflowTemplate('BIL', t.template_id)).toBeNull();
    expect(deleteWorkflowTemplate('BIL', t.template_id)).toBe(false);
  });

  it('update name + description + steps + is_default', () => {
    const t = createWorkflowTemplate('BANK_DEMO', { name: 'XyzWF', domain: 'recovery', steps: sampleSteps }, 'a', NOW);
    const u = updateWorkflowTemplate('BANK_DEMO', t.template_id, {
      name: 'Renamed',
      is_default: true,
      steps: [{ step_order: 1, name: 'Solo step', description: '', required_role: 'admin', expected_duration_hours: 48, optional: false }],
    }, new Date(NOW.getTime() + 1000));
    expect(u.name).toBe('Renamed');
    expect(u.is_default).toBe(true);
    expect(u.steps).toHaveLength(1);
  });

  it('update on unknown throws', () => {
    expect(() => updateWorkflowTemplate('BANK_DEMO', 'bogus', { name: 'NewName' }, NOW)).toThrow(WorkflowTemplateError);
  });

  it('delete on hit returns true + makes get null', () => {
    const t = createWorkflowTemplate('BANK_DEMO', { name: 'XyzWF', domain: 'recovery', steps: sampleSteps }, 'a', NOW);
    expect(deleteWorkflowTemplate('BANK_DEMO', t.template_id)).toBe(true);
    expect(getWorkflowTemplate('BANK_DEMO', t.template_id)).toBeNull();
  });
});

describe('clone', () => {
  it('clone copies steps + appends "Cloned from" to description + clears is_default', () => {
    const t = createWorkflowTemplate(
      'BANK_DEMO',
      { name: 'Original', domain: 'recovery', description: 'standard', steps: sampleSteps, is_default: true },
      'alice',
      NOW,
    );
    const clone = cloneWorkflowTemplate('BANK_DEMO', t.template_id, 'Original Copy', 'bob', new Date(NOW.getTime() + 1000));
    expect(clone.template_id).not.toBe(t.template_id);
    expect(clone.name).toBe('Original Copy');
    expect(clone.is_default).toBe(false);
    expect(clone.description).toMatch(/^Cloned from Original/);
    expect(clone.steps).toHaveLength(3);
  });

  it('cross-tenant clone throws', () => {
    const t = createWorkflowTemplate('BANK_DEMO', { name: 'XyzWF', domain: 'recovery', steps: sampleSteps }, 'a', NOW);
    expect(() => cloneWorkflowTemplate('BIL', t.template_id, 'CopiedName', 'a', NOW)).toThrow(WorkflowTemplateError);
  });
});

describe('validation', () => {
  it('rejects invalid name + domain + empty steps + > 30 steps + duplicate order + bad duration', () => {
    expect(() => createWorkflowTemplate('BANK_DEMO', { name: '@@', domain: 'recovery', steps: sampleSteps }, 'a', NOW)).toThrow(WorkflowTemplateError);
    // @ts-expect-error testing bad domain
    expect(() => createWorkflowTemplate('BANK_DEMO', { name: 'NameOK', domain: 'bogus', steps: sampleSteps }, 'a', NOW)).toThrow(WorkflowTemplateError);
    expect(() => createWorkflowTemplate('BANK_DEMO', { name: 'NameOK', domain: 'recovery', steps: [] }, 'a', NOW)).toThrow(WorkflowTemplateError);
    const tooMany = new Array(31).fill(null).map((_, i) => ({ step_order: i + 1, name: `step${i}`, description: '', required_role: 'analyst', expected_duration_hours: 1, optional: false }));
    expect(() => createWorkflowTemplate('BANK_DEMO', { name: 'NameOK', domain: 'recovery', steps: tooMany }, 'a', NOW)).toThrow(WorkflowTemplateError);
    const dup = [
      { step_order: 1, name: 'alpha', description: '', required_role: 'r', expected_duration_hours: 1, optional: false },
      { step_order: 1, name: 'bravo', description: '', required_role: 'r', expected_duration_hours: 1, optional: false },
    ];
    expect(() => createWorkflowTemplate('BANK_DEMO', { name: 'NameOK', domain: 'recovery', steps: dup }, 'a', NOW)).toThrow(WorkflowTemplateError);
    const badDur = [{ step_order: 1, name: 'alpha', description: '', required_role: 'r', expected_duration_hours: -1, optional: false }];
    expect(() => createWorkflowTemplate('BANK_DEMO', { name: 'NameOK', domain: 'recovery', steps: badDur }, 'a', NOW)).toThrow(WorkflowTemplateError);
  });
});
