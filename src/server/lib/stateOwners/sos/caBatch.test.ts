import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { caBatchPageFunctionSource } from './caBatchPageFunction.js';
import {
  caBatchItemComplete,
  loadCaBatchCheckpoint,
  mapCaBatchItemToResult,
  runCaBatch,
  saveCaBatchCheckpoint,
} from './caBatch.js';
import {
  caBatchExtractPdfText,
  caBatchIsChallenge,
  caBatchLatestSiDocumentId,
  caBatchPickEntity,
  caBatchRowsFromPayload,
  caBatchCompanyKey,
} from './caBatchLogic.js';
import { parseSiOfficerTable } from './caSi.js';
import { parseOfficerRoster } from './officers.js';
import { ApifySpendTracker, estimateCaBatchUsd, proxyGbFromApifyRun, usdFromApifyRun } from './spend.js';
import { isWaterfallReady } from './waterfall.js';
import { lookupBusinessOwner } from '../../../services/lookupBusinessOwner.js';
import { resetJobsForTests } from './jobs.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('CA batch isomorphic helpers (recorded fixtures)', () => {
  it('detects the recorded Incapsula block and never treats it as a match', () => {
    const html = readFileSync(join(dir, 'ca-incapsula-block.html'), 'utf8');
    assert.equal(caBatchIsChallenge(html), true);
    assert.equal(parseSiOfficerTable(html).length, 0);
  });

  it('picks the Oakland entity on name + city from recorded keyword JSON', () => {
    const payload = JSON.parse(readFileSync(join(dir, 'ca-bizfile-keyword.json'), 'utf8'));
    const rows = caBatchRowsFromPayload(payload);
    const oak = caBatchPickEntity('Sample Builders LLC', 'Oakland', rows);
    assert.equal(oak?.entity.EntityID, '202399900002');
    const sac = caBatchPickEntity('Sample Builders LLC', 'Sacramento', rows);
    assert.equal(sac?.entity.EntityID, '202399900001');
  });

  it('picks from the recorded public bizfileOnline row shape', () => {
    const payload = JSON.parse(readFileSync(join(dir, 'ca-bizfileonline-search.json'), 'utf8'));
    const oak = caBatchPickEntity('Sample Builders LLC', 'Oakland', caBatchRowsFromPayload(payload));
    assert.equal(oak?.entity.EntityID, '202399900002');
  });

  it('finds the latest Statement of Information document id', () => {
    const history = JSON.parse(readFileSync(join(dir, 'ca-si-history.json'), 'utf8'));
    assert.equal(caBatchLatestSiDocumentId(history), '000111222333444555666777888999000111222333444555');
  });

  it('extracts officer literals from a PDF latin1 string', () => {
    const pdf = '%PDF-1.1\nBT (Chief Executive Officer: JANE SAMPLE) Tj ET\n%%EOF\n';
    const text = caBatchExtractPdfText(pdf);
    assert.equal(parseOfficerRoster(text)[0]?.name, 'JANE SAMPLE');
  });

  it('parses the recorded SI officer table (CEO, CFO, Secretary, Directors, Managers)', () => {
    const text = readFileSync(join(dir, 'ca-si-officer-table.txt'), 'utf8');
    const rows = parseSiOfficerTable(text);
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('JANE SAMPLE'));
    assert.ok(names.includes('RIVER SAMPLE'));
    assert.ok(names.includes('JOHN SAMPLE'));
    assert.ok(names.includes('ALEX SAMPLE'));
    assert.ok(names.includes('PAT MORGAN'));
  });
});

describe('CA batch pageFunction source', () => {
  it('embeds search, history, SI image, reclear, and pushData', () => {
    const src = caBatchPageFunctionSource();
    assert.match(src, /async function pageFunction/);
    assert.match(src, /businessSearch/);
    assert.match(src, /History\/business/);
    assert.match(src, /GetImageByNum/);
    assert.match(src, /pushData/);
    assert.match(src, /reclear|incapsula_not_cleared|rechallenge/);
    assert.match(src, /userData/);
    assert.equal(/:\s*string\b/.test(src.replace(/"[\s\S]*?"/g, '""')), false);
  });
});

describe('CA batch mapping + waterfall_ready', () => {
  it('marks officers waterfall_ready only with a confirmed entity_id', async () => {
    const input = { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' };
    const si = readFileSync(join(dir, 'ca-si-officer-table.txt'), 'utf8');
    const withEntity = await mapCaBatchItemToResult(input, {
      company_name: input.company_name,
      city: 'Oakland',
      state: 'CA',
      status: 'ok',
      retries: 0,
      entity_id: '202399900002',
      business_name: 'SAMPLE BUILDERS LLC',
      match_method: 'exact',
      source_url: 'https://bizfileonline.sos.ca.gov/search/business/202399900002',
      officers_text: si,
    });
    assert.ok(withEntity.people.some((p) => isWaterfallReady(p)));
    assert.equal(withEntity.entity_id, '202399900002');

    const noEntity = await mapCaBatchItemToResult(input, {
      company_name: input.company_name,
      city: 'Oakland',
      state: 'CA',
      status: 'ok',
      retries: 0,
      officers_text: si,
    });
    assert.equal(noEntity.people.some((p) => isWaterfallReady(p)), false);
    assert.equal(noEntity.coverage_reason, 'not_found');
  });

  it('does not parse officers from a challenge body', async () => {
    const html = readFileSync(join(dir, 'ca-incapsula-block.html'), 'utf8');
    const got = await mapCaBatchItemToResult(
      { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
      {
        company_name: 'Sample Builders LLC',
        city: 'Oakland',
        state: 'CA',
        status: 'ok',
        retries: 0,
        entity_id: '202399900002',
        officers_text: html,
      },
    );
    assert.equal(got.people.length, 0);
    assert.equal(got.coverage_reason, 'agent_only');
  });

  it('OCRs scanned SI bytes on the host when in-session text is empty', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0x00]);
    const got = await mapCaBatchItemToResult(
      { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
      {
        company_name: 'Sample Builders LLC',
        city: 'Oakland',
        state: 'CA',
        status: 'ok',
        retries: 0,
        entity_id: '202399900002',
        source_url: 'https://bizfileonline.sos.ca.gov/search/business/202399900002',
        bytesBase64: Buffer.from(jpeg).toString('base64'),
        contentType: 'image/jpeg',
      },
      { ocr: async () => 'CEO\nJANE SAMPLE' },
    );
    assert.equal(got.ocr_used, true);
    assert.equal(got.people[0]?.last_name, 'SAMPLE');
    assert.equal(isWaterfallReady(got.people[0]!), true);
  });
});

describe('CA batch spend + checkpoint', () => {
  it('prices a 50-company probe under a dollar', () => {
    assert.equal(estimateCaBatchUsd(50), 0.19);
    assert.ok(estimateCaBatchUsd(400) < 2);
  });

  it('reads CU and residential proxy GB from an Apify run', () => {
    const cost = usdFromApifyRun({
      status: 'SUCCEEDED',
      usageTotalUsd: 0.12,
      usage: { PROXY_RESIDENTIAL_TRANSFER_GBYTES: 0.02, ACTOR_COMPUTE_UNITS: 0.6 },
      stats: { computeUnits: 0.6 },
    });
    assert.equal(cost.usd, 0.12);
    assert.equal(cost.cu, 0.6);
    assert.equal(cost.proxyGb, 0.02);
    assert.equal(proxyGbFromApifyRun({ usage: { PROXY_RESIDENTIAL_TRANSFER_GBYTES: 0.02 } }), 0.02);
  });

  it('skips completed checkpoint keys and retries blocked under the cap', () => {
    assert.equal(caBatchItemComplete({ company_name: 'A', city: '', state: 'CA', status: 'ok', retries: 0 }), true);
    assert.equal(
      caBatchItemComplete({ company_name: 'A', city: '', state: 'CA', status: 'blocked', retries: 1 }),
      false,
    );
    assert.equal(
      caBatchItemComplete({ company_name: 'A', city: '', state: 'CA', status: 'blocked', retries: 3 }),
      true,
    );
  });

  it('runs one Playwright actor with sticky residential proxy and userData companies', async () => {
    const spend = new ApifySpendTracker();
    const tmp = mkdtempSync(join(tmpdir(), 'ca-batch-'));
    const checkpointPath = join(tmp, 'ckpt.json');
    let runPosts = 0;
    let captured: Record<string, unknown> | null = null;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/acts/') && init?.method === 'POST') {
        runPosts += 1;
        captured = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: {
              id: 'run-ca',
              status: 'SUCCEEDED',
              defaultDatasetId: 'ds-ca',
              usageTotalUsd: 0.11,
              usage: { PROXY_RESIDENTIAL_TRANSFER_GBYTES: 0.015 },
              stats: { computeUnits: 0.4 },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/datasets/ds-ca/items')) {
        const si = readFileSync(join(dir, 'ca-si-text.txt'), 'utf8');
        return new Response(
          JSON.stringify([
            {
              company_name: 'Sample Builders LLC',
              city: 'Oakland',
              state: 'CA',
              status: 'ok',
              retries: 0,
              entity_id: '202399900002',
              business_name: 'SAMPLE BUILDERS LLC',
              match_method: 'exact',
              source_url: 'https://bizfileonline.sos.ca.gov/search/business/202399900002',
              officers_text: si,
            },
          ]),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    };
    const got = await runCaBatch(
      [{ company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' }],
      { live: true, apifyToken: 'token', spend, fetch: fetchFn, caBatchCheckpointPath: checkpointPath },
      { jobId: 'job-ca', checkpointPath },
    );
    assert.equal(runPosts, 1);
    assert.equal(captured?.proxyRotation, 'UNTIL_FAILURE');
    assert.equal(captured?.maxConcurrency, 1);
    const proxy = captured?.proxyConfiguration as { apifyProxyGroups?: string[] };
    assert.deepEqual(proxy?.apifyProxyGroups, ['RESIDENTIAL']);
    const startUrls = captured?.startUrls as Array<{ userData?: { companies?: unknown[] } }>;
    assert.equal(startUrls[0]?.userData?.companies?.length, 1);
    assert.match(String(captured?.pageFunction || ''), /businessSearch/);
    assert.equal(got.results[0]?.entity_id, '202399900002');
    assert.ok(got.results[0]?.people.some((p) => isWaterfallReady(p)));
    assert.equal(spend.runs, 1);
    assert.ok(spend.usd > 0);
    assert.equal(spend.computeUnits, 0.4);
    assert.ok(spend.proxyGb > 0);
  });

  it('resumes from checkpoint and only sends unfinished companies', async () => {
    const spend = new ApifySpendTracker();
    const tmp = mkdtempSync(join(tmpdir(), 'ca-batch-'));
    const checkpointPath = join(tmp, 'ckpt.json');
    saveCaBatchCheckpoint(checkpointPath, {
      version: 1,
      job_id: 'job-resume',
      updated_at: new Date().toISOString(),
      items: {
        [caBatchCompanyKey('Done Co', 'Oakland')]: {
          company_name: 'Done Co',
          city: 'Oakland',
          state: 'CA',
          status: 'ok',
          retries: 0,
          entity_id: '1',
          officers_text: 'CEO\nJANE SAMPLE',
          source_url: 'https://bizfileonline.sos.ca.gov/search/business/1',
        },
      },
    });
    let sent: unknown[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/acts/') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}')) as {
          startUrls?: Array<{ userData?: { companies?: unknown[] } }>;
        };
        sent = body.startUrls?.[0]?.userData?.companies || [];
        return new Response(
          JSON.stringify({
            data: {
              id: 'run-resume',
              status: 'SUCCEEDED',
              defaultDatasetId: 'ds-resume',
              usageTotalUsd: 0.05,
              stats: { computeUnits: 0.1 },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/datasets/ds-resume/items')) {
        return new Response(
          JSON.stringify([
            {
              company_name: 'Next Co',
              city: 'Oakland',
              state: 'CA',
              status: 'not_found',
              retries: 0,
            },
          ]),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    };
    const got = await runCaBatch(
      [
        { company_name: 'Done Co', city: 'Oakland', state: 'CA' },
        { company_name: 'Next Co', city: 'Oakland', state: 'CA' },
      ],
      { live: true, apifyToken: 'token', spend, fetch: fetchFn, caBatchCheckpointPath: checkpointPath },
      { jobId: 'job-resume', checkpointPath },
    );
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as { company_name: string }).company_name, 'Next Co');
    assert.equal(got.results[0]?.entity_id, '1');
    assert.equal(got.results[1]?.coverage_reason, 'not_found');
    const saved = loadCaBatchCheckpoint(checkpointPath, 'job-resume');
    assert.equal(saved.items[caBatchCompanyKey('Next Co', 'Oakland')]?.status, 'not_found');
  });

  it('refuses a new run at APIFY_MAX_USD without charging', async () => {
    const spend = new ApifySpendTracker();
    spend.capUsd = 0;
    let posts = 0;
    const fetchFn: typeof fetch = async () => {
      posts += 1;
      return new Response('nope', { status: 500 });
    };
    const tmp = mkdtempSync(join(tmpdir(), 'ca-batch-'));
    const got = await runCaBatch(
      [{ company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' }],
      {
        live: true,
        apifyToken: 'token',
        apifyMaxUsd: 0,
        spend,
        fetch: fetchFn,
        caBatchCheckpointPath: join(tmp, 'ckpt.json'),
      },
      { jobId: 'job-cap', checkpointPath: join(tmp, 'ckpt.json') },
    );
    assert.equal(got.refused, true);
    assert.equal(posts, 0);
    assert.equal(spend.usd, 0);
  });
});

describe('lookup_business_owner ca_batch job path', () => {
  it('exposes ca_batch on estimate_only and records CU/GB fields on a fixture run', async () => {
    resetJobsForTests();
    const estimate = await lookupBusinessOwner({
      estimate_only: true,
      ca_batch: true,
      rows: Array.from({ length: 50 }, (_, i) => ({
        company_name: `Sample Co ${i}`,
        city: 'Oakland',
        state: 'CA',
      })),
    });
    assert.equal(estimate.ca_batch, true);
    assert.equal(estimate.apify_estimate_usd, 0.19);
    assert.equal(estimate.serper_estimate_credits, 0);

    const si = readFileSync(join(dir, 'ca-si-officer-table.txt'), 'utf8');
    const tmp = mkdtempSync(join(tmpdir(), 'ca-batch-'));
    const out = await lookupBusinessOwner({
      dry_run: true,
      ca_batch: true,
      context: {
        live: false,
        caBatchCheckpointPath: join(tmp, 'ckpt.json'),
        caBatchItems: [
          {
            company_name: 'Sample Builders LLC',
            city: 'Oakland',
            state: 'CA',
            status: 'ok',
            retries: 0,
            entity_id: '202399900002',
            match_method: 'exact',
            source_url: 'https://bizfileonline.sos.ca.gov/search/business/202399900002',
            officers_text: si,
          },
        ],
      },
      rows: [{ company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' }],
    });
    assert.equal(out.ok, true);
    assert.equal(out.ca_batch, true);
    assert.equal(out.named, 1);
    assert.equal(out.processed, 1);
    assert.equal(out.apify_compute_units, 0);
    assert.equal(out.apify_proxy_gb, 0);
  });
});
