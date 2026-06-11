// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildDataFreshnessReport } from '../src/data_freshness_report';
import { InMemoryIngestionRegistry } from '../src/ingestion';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildDataFreshnessReport', () => {
  it('returns connectors sorted by freshness_ratio desc', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildDataFreshnessReport(registry, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(Array.isArray(out.connectors)).toBe(true);
    // All default connectors have null last_run_at → never_run
    expect(out.never_run_count).toBe(out.connectors.length);
    expect(out.overall_freshness_score).toBe(0);
  });

  it('has required envelope fields', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildDataFreshnessReport(registry, 'BIL', NOW);
    expect(out.generated_at).toBeDefined();
    expect(typeof out.stale_count).toBe('number');
    expect(typeof out.very_stale_count).toBe('number');
    expect(typeof out.never_run_count).toBe('number');
    expect(typeof out.overall_freshness_score).toBe('number');
  });

  it('correctly classifies fresh connector', () => {
    const registry = new InMemoryIngestionRegistry();
    // Run a connector so it has a recent last_run_at
    registry.runNow('BIL', 'cbs_loan_book', 'admin', NOW);
    const out = buildDataFreshnessReport(registry, 'BIL', NOW);
    const cbsRow = out.connectors.find(c => c.connector_id === 'cbs_loan_book');
    expect(cbsRow).toBeDefined();
    expect(cbsRow.data_age_tier).toBe('fresh');
    expect(cbsRow.freshness_ratio).toBeLessThan(1.5);
  });

  it('does not leak across tenants', () => {
    const registry = new InMemoryIngestionRegistry();
    registry.runNow('BIL', 'cbs_loan_book', 'admin', NOW);
    const outBank = buildDataFreshnessReport(registry, 'BANK_DEMO', NOW);
    // BANK_DEMO has separate state
    const cbsBank = outBank.connectors.find(c => c.connector_id === 'cbs_loan_book');
    expect(cbsBank.data_age_tier).toBe('never_run');
  });

  it('freshest_connector is null for all-never-run', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildDataFreshnessReport(registry, 'BIL', NOW);
    expect(out.freshest_connector).toBeNull();
  });

  it('stalest_connector is null for all-never-run', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildDataFreshnessReport(registry, 'BIL', NOW);
    expect(out.stalest_connector).toBeNull();
  });
});

describe('GET /v1/ingestion/data/freshness-report', () => {
  it('returns 200 for admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/ingestion/data/freshness-report')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.connectors)).toBe(true);
  });

  it('returns 403 for non-admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/ingestion/data/freshness-report')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
