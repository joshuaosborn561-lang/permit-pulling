import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getJob, resetJobsForTests } from '../lib/stateOwners/sos/jobs.js';
import {
  APIFY_USD_PER_BLOCKED_LOOKUP,
  PHASE1_WRITES_ENABLED,
  WRITES_ENABLED,
  getBusinessOwnerJob,
  lookupBusinessOwner,
} from './lookupBusinessOwner.js';
import { sourceForState } from '../lib/stateOwners/router.js';
import { resolveCslb } from '../lib/stateOwners/cslb.js';

describe('lookup_business_owner scaffold', () => {
  it('returns a first-use envelope on estimate_only without calling SOS', async () => {
    const out = await lookupBusinessOwner({ estimate_only: true });
    assert.equal(out.ok, true);
    assert.equal(out.writes_enabled, false);
    assert.equal(PHASE1_WRITES_ENABLED, false);
    assert.equal(WRITES_ENABLED, false);
    assert.equal(out.phase, 2);
    const first = out.first_use as {
      assumed_total: number;
      ca_direct_http_usd: number;
      ca_bizfile_api: string;
      ca_apify_mid_usd: number;
      serper_credits: number;
      serper_usd: number;
      serper_queries_per_row: number;
    };
    assert.equal(first.assumed_total, 15359);
    assert.equal(first.ca_direct_http_usd, 0);
    assert.equal(first.ca_bizfile_api, 'unavailable_government_agencies_only');
    assert.ok(first.ca_apify_mid_usd > 100);
    assert.equal(out.apify_estimate_usd, 0);
    assert.equal(first.serper_queries_per_row, 5);
    assert.equal(first.serper_credits, 15359 * 5);
    assert.ok(first.serper_usd > 0);
    assert.equal(out.serper_estimate_credits, 15359 * 5);
    assert.ok(APIFY_USD_PER_BLOCKED_LOOKUP > 0);
    const priced = await lookupBusinessOwner({
      estimate_only: true,
      rows: [
        { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
        { company_name: 'Sample HVAC LLC', city: 'Denver', state: 'CO' },
      ],
    });
    assert.equal(priced.serper_estimate_credits, 10);
    assert.equal(priced.serper_estimate_usd, 0.01);
  });

  it('records a dry job with counts only', async () => {
    resetJobsForTests();
    const out = await lookupBusinessOwner({
      dry_run: true,
      context: { live: false },
      rows: [
        { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
        { company_name: 'Sample HVAC LLC', city: 'Denver', state: 'CO' },
      ],
    });
    assert.equal(out.ok, true);
    assert.equal(out.processed, 2);
    assert.equal(out.named, 0);
    assert.equal(out.writes_enabled, false);
    const job = getJob(String(out.job_id));
    assert.equal(job?.status, 'completed');
    const fetched = await getBusinessOwnerJob(String(out.job_id));
    assert.equal(fetched.ok, true);
    assert.equal(fetched.processed, 2);
  });

  it('batches rows, records job status, and spends $0 without Apify', async () => {
    resetJobsForTests();
    const out = await lookupBusinessOwner({
      dry_run: true,
      wait: true,
      context: { live: false, caPayload: { RecordCount: 0, EntityData: [] } },
      rows: [
        { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
        { company_name: 'Sample Masonry LLC', city: 'Columbus', state: 'OH' },
      ],
    });
    assert.equal(out.ok, true);
    assert.equal(out.status, 'completed');
    assert.equal(out.processed, 2);
    assert.equal(out.apify_usd_spent, 0);
    const job = await getBusinessOwnerJob(String(out.job_id));
    assert.equal(job.status, 'completed');
    assert.equal(job.phase, 2);
  });
});

describe('permit path unchanged', () => {
  it('still routes CA to CSLB and fails closed without a license number', async () => {
    assert.equal(sourceForState('CA'), 'cslb');
    const result = await resolveCslb({
      list_id: 'x',
      lead_id: 1,
      company_name: 'Sample Builders LLC',
      state: 'CA',
      city: 'Oakland',
    });
    assert.equal(result.coverage_reason, 'no_license_number');
    assert.equal(result.people.length, 0);
  });
});
