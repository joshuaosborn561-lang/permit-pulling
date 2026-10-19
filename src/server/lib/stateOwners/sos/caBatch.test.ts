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
  caBatchIsWafBlock,
  caBatchLatestSiDocumentId,
  caBatchMapRow,
  caBatchPickEntity,
  caBatchRowsFromPayload,
  caBatchCompanyKey,
} from './caBatchLogic.js';
import { parseSiOfficerTable } from './caSi.js';
import { parseOfficerRoster } from './officers.js';
import { caBatchShouldHybrid, caHybridMaxResults } from './caHybrid.js';
import { ApifySpendTracker, estimateCaBatchUsd, estimateCaHybridUsd, proxyGbFromApifyRun, usdFromApifyRun } from './spend.js';
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

  it('does not substring-match a 1-token query without a city match', () => {
    const rows = [{ EntityID: '1', EntityName: '4404 APPLE TREE LLC', EntityCity: 'FRESNO' }];
    assert.equal(caBatchPickEntity('APPLE', 'Oakland', rows), null);
    const withCity = caBatchPickEntity('APPLE', 'Fresno', rows);
    assert.equal(withCity?.entity.EntityID, '1');
    assert.equal(withCity?.method, 'substring');
    assert.equal(withCity?.city_match, true);
  });

  it('picks using the core company name after stripping marketing text', () => {
    const payload = JSON.parse(readFileSync(join(dir, 'ca-bizfile-keyword.json'), 'utf8'));
    const oak = caBatchPickEntity(
      'Sample Builders LLC - Extra Marketing',
      'Oakland',
      caBatchRowsFromPayload(payload),
    );
    assert.equal(oak?.entity.EntityID, '202399900002');
    assert.equal(oak?.method, 'exact');
    assert.equal(oak?.city_match, true);
  });

  it('finds the latest Statement of Information document id', () => {
    const history = JSON.parse(readFileSync(join(dir, 'ca-si-history.json'), 'utf8'));
    assert.equal(caBatchLatestSiDocumentId(history), '000111222333444555666777888999000111222333444555');
  });

  it('maps live dz_omar rows (name/entityNumber/principalAddress) and prefers SI over Initial Filing', () => {
    const row = {
      searchQuery: 'Sample Builders LLC',
      name: 'SAMPLE BUILDERS LLC',
      entityNumber: '202399900002',
      status: 'Active',
      principalAddress: '100 MAIN ST, OAKLAND, CA 94612',
      filings: [
        {
          type: 'Statement of Information',
          date: '2/6/2026',
          documentUrl: 'https://bizfileonline.sos.ca.gov/api/report/GetImageByNum/000111222333444555666777888999000111222333444555',
        },
        {
          type: 'Initial Filing',
          date: '1/11/2021',
          documentUrl: 'https://bizfileonline.sos.ca.gov/api/report/GetImageByNum/111149184243144165204173177061167234074130193178',
        },
      ],
    };
    const mapped = caBatchMapRow(row);
    assert.equal(mapped?.EntityID, '202399900002');
    assert.equal(mapped?.EntityName, 'SAMPLE BUILDERS LLC');
    assert.equal(mapped?.EntityCity, 'OAKLAND');
    assert.equal(
      caBatchLatestSiDocumentId(row),
      '000111222333444555666777888999000111222333444555',
    );
    assert.equal(caBatchLatestSiDocumentId({ filings: [row.filings[1]] }), '');
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
  it('is a single function expression Apify can eval (no top-level const)', () => {
    const src = caBatchPageFunctionSource().trim();
    assert.equal(src.startsWith('async function pageFunction'), true);
    const beforeBrace = src.slice(0, src.indexOf('{'));
    assert.equal(/\bconst\b/.test(beforeBrace), false);
    assert.doesNotThrow(() => new Function(`return (${src})`));
    assert.equal(/export function/.test(src), false);
  });

  it('drives the search UI and treats 429 as blocked', () => {
    const src = caBatchPageFunctionSource();
    assert.match(src, /businessSearch/);
    assert.match(src, /waitForResponse/);
    assert.match(src, /\.type\(/);
    assert.match(src, /has-text\("Execute search"\)/);
    assert.match(src, /Search by name or file number/);
    assert.match(src, /block_page_before_search/);
    assert.match(src, /jitter\(3e4,\s*6e4\)|jitter\(30000,\s*60000\)/);
    assert.match(src, /has-text\("Search"\)/);
    assert.match(src, /waf_429/);
    assert.match(src, /caBatchIsWafBlock/);
    assert.match(src, /debug_steps/);
    assert.match(src, /History\/business/);
    assert.match(src, /GetImageByNum/);
    assert.match(src, /pushData/);
    assert.match(src, /search_no_response/);
    assert.match(src, /caBatchCoreSearchName/);
    assert.match(src, /search_dom/);
    assert.match(src, /jitter\(900,\s*2400\)/);
    assert.match(src, /ensureSearchPage/);
    assert.match(src, /reclear\(\)/);
    assert.match(src, /function __name\(/);
    assert.doesNotMatch(src, /page\.evaluate\([\s\S]{0,200}fetch\s*\(/);
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

    const trigramNoCity = await mapCaBatchItemToResult(input, {
      company_name: input.company_name,
      city: 'Oakland',
      state: 'CA',
      status: 'ok',
      retries: 0,
      entity_id: '202399900002',
      match_method: 'trigram',
      city_match: false,
      source_url: 'https://bizfileonline.sos.ca.gov/search/business/202399900002',
      officers_text: si,
    });
    assert.equal(trigramNoCity.people.some((p) => isWaterfallReady(p)), false);

    const trigramCity = await mapCaBatchItemToResult(input, {
      company_name: input.company_name,
      city: 'Oakland',
      state: 'CA',
      status: 'ok',
      retries: 0,
      entity_id: '202399900002',
      match_method: 'trigram',
      city_match: true,
      source_url: 'https://bizfileonline.sos.ca.gov/search/business/202399900002',
      officers_text: si,
    });
    assert.ok(trigramCity.people.some((p) => isWaterfallReady(p)));

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

  it('maps 429 / errorCode 15 to blocked, never not_found', async () => {
    const waf = JSON.stringify(
      JSON.parse(readFileSync(join(dir, 'ca-waf-429.json'), 'utf8')),
    );
    assert.equal(caBatchIsWafBlock(429, waf), true);
    assert.equal(caBatchIsWafBlock(200, waf), true);
    assert.equal(caBatchIsWafBlock(200, '{"RecordCount":0,"EntityData":[]}'), false);
    const got = await mapCaBatchItemToResult(
      { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
      {
        company_name: 'Sample Builders LLC',
        city: 'Oakland',
        state: 'CA',
        status: 'not_found',
        retries: 1,
        error: 'waf_429',
        officers_text: waf,
        debug_steps: [{ step: 'search', status: 429, errorCode: 15 }],
      },
    );
    assert.equal(got.coverage_reason, 'blocked');
    assert.equal(got.people.length, 0);

    const emptyAfterRetry = await mapCaBatchItemToResult(
      { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
      {
        company_name: 'Sample Builders LLC',
        city: 'Oakland',
        state: 'CA',
        status: 'not_found',
        retries: 1,
        debug_steps: [
          { step: 'search', status: 429, errorCode: 15 },
          { step: 'search', status: 200, bytes: 32 },
        ],
      },
    );
    assert.equal(emptyAfterRetry.coverage_reason, 'not_found');
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

  it('prices a 3-company hybrid run well under APIFY_MAX_USD=2', () => {
    assert.equal(estimateCaHybridUsd(3), 0.15);
    assert.equal(caHybridMaxResults(), 3);
    assert.equal(caHybridMaxResults({ caHybridMaxResultsPerQuery: 7 }), 7);
    assert.ok(estimateCaHybridUsd(3) < 0.5);
  });

  it('hybrids blocked UI rows, not confirmed matches or real not_found', () => {
    assert.equal(
      caBatchShouldHybrid({
        company_name: 'A',
        city: '',
        state: 'CA',
        status: 'blocked',
        retries: 1,
        error: 'search_input_missing',
      }),
      true,
    );
    assert.equal(
      caBatchShouldHybrid({
        company_name: 'A',
        city: '',
        state: 'CA',
        status: 'ok',
        retries: 0,
        entity_id: '1',
      }),
      false,
    );
    assert.equal(
      caBatchShouldHybrid({
        company_name: 'A',
        city: '',
        state: 'CA',
        status: 'not_found',
        retries: 0,
      }),
      false,
    );
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
      {
        live: true,
        apifyToken: 'token',
        spend,
        fetch: fetchFn,
        caBatchCheckpointPath: checkpointPath,
        caBatchDebug: true,
        caPlaywright: true,
      },
      { jobId: 'job-ca', checkpointPath },
    );
    assert.equal(runPosts, 1);
    assert.equal(captured?.proxyRotation, 'UNTIL_FAILURE');
    assert.equal(captured?.maxConcurrency, 1);
    assert.equal(captured?.maxRequestRetries, 0);
    assert.equal(captured?.pageFunctionTimeoutSecs, 600);
    assert.equal(captured?.pageLoadTimeoutSecs, 180);
    assert.equal(captured?.requestHandlerTimeoutSecs, 600);
    assert.equal(captured?.useChrome, true);
    assert.equal(captured?.headless, false);
    assert.equal(captured?.sessionPoolName, 'ca_bizfile_sticky');
    const proxy = captured?.proxyConfiguration as { apifyProxyGroups?: string[]; apifyProxyCountry?: string };
    assert.deepEqual(proxy?.apifyProxyGroups, ['RESIDENTIAL']);
    assert.equal(proxy?.apifyProxyCountry, 'US');
    const startUrls = captured?.startUrls as Array<{ userData?: { companies?: unknown[] } }>;
    assert.equal(startUrls[0]?.userData?.companies?.length, 1);
    assert.equal((startUrls[0]?.userData as { debug?: boolean })?.debug, true);
    assert.match(String(captured?.pageFunction || ''), /businessSearch/);
    assert.doesNotThrow(() => new Function(`return (${String(captured?.pageFunction || '')})`));
    assert.equal(String(captured?.pageFunction || '').trim().startsWith('async function pageFunction'), true);
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
      {
        live: true,
        apifyToken: 'token',
        spend,
        fetch: fetchFn,
        caBatchCheckpointPath: checkpointPath,
        caPlaywright: true,
      },
      { jobId: 'job-resume', checkpointPath },
    );
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as { company_name: string }).company_name, 'Next Co');
    assert.equal(got.results[0]?.entity_id, '1');
    assert.equal(got.results[1]?.coverage_reason, 'not_found');
    const saved = loadCaBatchCheckpoint(checkpointPath, 'job-resume');
    assert.equal(saved.items[caBatchCompanyKey('Next Co', 'Oakland')]?.status, 'not_found');
  });

  it('falls back to dz_omar + web-fetch when the UI search box never appears', async () => {
    const spend = new ApifySpendTracker();
    const tmp = mkdtempSync(join(tmpdir(), 'ca-batch-'));
    const checkpointPath = join(tmp, 'ckpt.json');
    const actors: string[] = [];
    const si = readFileSync(join(dir, 'ca-si-officer-table.txt'), 'utf8');
    const hybridRows = JSON.parse(readFileSync(join(dir, 'ca-hybrid-dz-omar.json'), 'utf8'));
    let runSeq = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/acts/') && init?.method === 'POST') {
        const actor = url.includes('dz_omar')
          ? 'dz_omar'
          : url.includes('web-fetch')
            ? 'web-fetch'
            : 'playwright';
        actors.push(actor);
        runSeq += 1;
        const id = `run-${actor}-${runSeq}`;
        const ds = `ds-${actor}-${runSeq}`;
        return new Response(
          JSON.stringify({
            data: {
              id,
              status: 'SUCCEEDED',
              defaultDatasetId: ds,
              usageTotalUsd: actor === 'playwright' ? 0.08 : 0.03,
              stats: { computeUnits: 0.1 },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/datasets/ds-playwright') && url.includes('/items')) {
        return new Response(
          JSON.stringify([
            {
              company_name: 'Sample Builders LLC',
              city: 'Oakland',
              state: 'CA',
              status: 'blocked',
              retries: 1,
              error: 'search_input_missing',
              debug_steps: [{ step: 'search_input', status: 0, error: 'search_input_missing', bytes: 512 }],
            },
          ]),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/datasets/ds-dz_omar') && url.includes('/items')) {
        return new Response(JSON.stringify(hybridRows), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/datasets/ds-web-fetch') && url.includes('/items')) {
        return new Response(JSON.stringify([{ text: si, markdown: si }]), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/actor-runs/')) {
        return new Response(JSON.stringify({ data: { status: 'SUCCEEDED' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    };
    const got = await runCaBatch(
      [{ company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' }],
      {
        live: true,
        apifyToken: 'token',
        spend,
        fetch: fetchFn,
        caBatchCheckpointPath: checkpointPath,
        caPlaywright: true,
      },
      { jobId: 'job-hybrid', checkpointPath },
    );
    assert.deepEqual(actors, ['playwright', 'dz_omar', 'web-fetch']);
    assert.equal(got.hybridUsed, true);
    assert.equal(got.results[0]?.entity_id, '202399900002');
    assert.ok(got.results[0]?.people.some((p) => isWaterfallReady(p)));
    assert.ok((got.perCompanyUsd || 0) >= 0);
  });

  it('skips Playwright on --ca-hybrid-only and uses maxResultsPerQuery 3', async () => {
    const spend = new ApifySpendTracker();
    const tmp = mkdtempSync(join(tmpdir(), 'ca-batch-'));
    const checkpointPath = join(tmp, 'ckpt.json');
    const actors: string[] = [];
    const captured: Record<string, unknown>[] = [];
    const si = readFileSync(join(dir, 'ca-si-officer-table.txt'), 'utf8');
    const hybridRows = JSON.parse(readFileSync(join(dir, 'ca-hybrid-dz-omar.json'), 'utf8'));
    let runSeq = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/acts/') && init?.method === 'POST') {
        const actor = url.includes('dz_omar')
          ? 'dz_omar'
          : url.includes('web-fetch')
            ? 'web-fetch'
            : 'playwright';
        actors.push(actor);
        captured.push(JSON.parse(String(init.body || '{}')) as Record<string, unknown>);
        runSeq += 1;
        const id = `run-${actor}-${runSeq}`;
        const ds = `ds-${actor}-${runSeq}`;
        return new Response(
          JSON.stringify({
            data: {
              id,
              status: 'SUCCEEDED',
              defaultDatasetId: ds,
              usageTotalUsd: 0.03,
              stats: { computeUnits: 0.1 },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/datasets/') && url.includes('/items')) {
        if (url.includes('dz_omar')) {
          return new Response(JSON.stringify(hybridRows), { headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('web-fetch')) {
          return new Response(JSON.stringify([{ text: si, markdown: si }]), {
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      if (url.includes('/actor-runs/')) {
        return new Response(JSON.stringify({ data: { status: 'SUCCEEDED' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    };
    const got = await runCaBatch(
      [{ company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' }],
      {
        live: true,
        apifyToken: 'token',
        spend,
        fetch: fetchFn,
        caBatchCheckpointPath: checkpointPath,
        caHybridOnly: true,
        caHybridMaxResultsPerQuery: 3,
      },
      { jobId: 'job-hybrid-only', checkpointPath },
    );
    assert.equal(actors.includes('playwright'), false);
    assert.deepEqual(actors.filter((a) => a === 'dz_omar' || a === 'web-fetch').slice(0, 2), ['dz_omar', 'web-fetch']);
    assert.equal(captured[0]?.maxResultsPerQuery, 3);
    assert.equal(got.hybridUsed, true);
    assert.equal(got.results[0]?.entity_id, '202399900002');
    assert.ok(got.results[0]?.people.some((p) => isWaterfallReady(p)));
  });

  it('retries a shortened company query when the first search misses', async () => {
    const spend = new ApifySpendTracker();
    const tmp = mkdtempSync(join(tmpdir(), 'ca-batch-'));
    const checkpointPath = join(tmp, 'ckpt.json');
    const queries: string[][] = [];
    const si = readFileSync(join(dir, 'ca-si-officer-table.txt'), 'utf8');
    let dzRuns = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/acts/') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}')) as { searchQueries?: string[] };
        if (url.includes('dz_omar')) {
          dzRuns += 1;
          queries.push(body.searchQueries || []);
        }
        const actor = url.includes('dz_omar') ? 'dz_omar' : 'web-fetch';
        const id = `run-${actor}-${dzRuns}`;
        const ds = `ds-${actor}-${dzRuns}`;
        return new Response(
          JSON.stringify({
            data: { id, status: 'SUCCEEDED', defaultDatasetId: ds, usageTotalUsd: 0.02, stats: { computeUnits: 0.05 } },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/datasets/ds-dz_omar-1/items')) {
        return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/datasets/ds-dz_omar-2/items')) {
        return new Response(
          JSON.stringify([
            {
              searchQuery: 'SAMPLE BUILDERS',
              name: 'SAMPLE BUILDERS LLC',
              entityNumber: '202399900002',
              city: 'Oakland',
              filings: [
                {
                  type: 'Statement of Information',
                  documentUrl: 'https://bizfileonline.sos.ca.gov/api/report/GetImageByNum/000111222333444555666777888999000111222333444555',
                },
              ],
            },
          ]),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/datasets/') && url.includes('web-fetch')) {
        return new Response(JSON.stringify([{ text: si }]), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/actor-runs/')) {
        return new Response(JSON.stringify({ data: { status: 'SUCCEEDED' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    };
    const got = await runCaBatch(
      [{ company_name: 'Sample Builders LLC - Extra Marketing', city: 'Oakland', state: 'CA' }],
      {
        live: true,
        apifyToken: 'token',
        spend,
        fetch: fetchFn,
        caBatchCheckpointPath: checkpointPath,
      },
      { jobId: 'job-short-query', checkpointPath },
    );
    assert.equal(dzRuns, 2);
    assert.equal(queries[0]?.[0], 'Sample Builders LLC');
    assert.equal(queries[1]?.[0], 'SAMPLE BUILDERS');
    assert.equal(got.results[0]?.entity_id, '202399900002');
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
    assert.equal(estimate.apify_estimate_usd, estimateCaHybridUsd(50));
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
