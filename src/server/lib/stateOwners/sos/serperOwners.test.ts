import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { LookupContext } from './context.js';
import { resolveNameLookup } from './namePath.js';
import {
  blobHasState,
  companyTiedToBlob,
  resolveSerperOwner,
  scoreSerperOrganic,
  serperOfficerQuery,
  serperSiteQuery,
} from './serperOwners.js';
import { SerperCreditTracker } from './spend.js';
import { isWaterfallReady } from './waterfall.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('serper owner tier', () => {
  const input = { company_name: 'ACME BUILDERS LLC', city: 'Oakland', state: 'CA' };

  it('builds the officer query and a site-targeted OpenCorporates/Bizapedia/SOS query', () => {
    const q = serperOfficerQuery(input);
    assert.match(q, /ACME BUILDERS LLC/);
    assert.match(q, /Oakland/);
    assert.match(q, /officer OR owner OR CEO OR president OR manager/);
    const site = serperSiteQuery(input);
    assert.match(site, /site:opencorporates\.com/);
    assert.match(site, /site:bizapedia\.com/);
    assert.match(site, /bizfileonline\.sos\.ca\.gov/);
  });

  it('accepts a high-confidence OpenCorporates snippet tied to company + city + state', () => {
    const payload = JSON.parse(readFileSync(join(dir, 'serper-organic.json'), 'utf8'));
    const cand = scoreSerperOrganic(input, payload.organic[0]);
    assert.ok(cand);
    assert.equal(cand?.confidence, 'high');
    assert.ok((cand?.score || 0) >= 0.8);
    assert.match(cand?.entry.name || '', /Jane Sample/i);
  });

  it('rejects Cloudflare challenge snippets and cookies-as-COO', () => {
    assert.equal(
      scoreSerperOrganic(input, {
        title: 'Just a moment...',
        link: 'https://www.sosnc.gov/online_services/search/by_title/_Business_Registration',
        snippet: 'Enable JavaScript and cookies to continue',
      }),
      null,
    );
  });

  it('rejects a person that is not tied to the same company name', () => {
    assert.equal(
      scoreSerperOrganic(input, {
        title: 'OTHER PIPE LLC — John Other, CEO | OpenCorporates',
        link: 'https://opencorporates.com/companies/us_ca/999',
        snippet: 'John Other is the CEO of OTHER PIPE LLC in Oakland, California.',
      }),
      null,
    );
  });

  it('requires city or state in the snippet', () => {
    assert.equal(
      scoreSerperOrganic(input, {
        title: 'ACME BUILDERS LLC officers',
        link: 'https://opencorporates.com/companies/us_tx/1',
        snippet: 'Jane Sample is the President of ACME BUILDERS LLC.',
      }),
      null,
    );
    assert.equal(blobHasState('Oakland, CA 94612', 'CA'), true);
    assert.equal(blobHasState('located in California', 'CA'), true);
    assert.equal(companyTiedToBlob('ACME BUILDERS LLC', 'President of ACME BUILDERS LLC')?.method, 'substring');
  });

  it('marks medium-confidence directory hits not waterfall-ready', () => {
    const cand = scoreSerperOrganic(input, {
      title: 'ACME BUILDERS LLC company profile',
      link: 'https://www.example-directory.test/acme-builders',
      snippet: 'President Jane Sample of ACME BUILDERS LLC, California.',
    });
    assert.ok(cand);
    assert.notEqual(cand?.confidence, 'high');
    const hit = {
      first_name: 'Jane',
      last_name: 'Sample',
      title: 'President',
      company_name: input.company_name,
      domain: null,
      source_url: cand!.source_url,
      confidence: cand!.confidence,
      confidence_score: cand!.score,
      state: 'CA',
      source: 'serper' as const,
      role: 'officer' as const,
      coverage_reason: null,
    };
    assert.equal(isWaterfallReady(hit), false);
  });

  it('tracks two Serper credits and skips Apify on a high-confidence hit', async () => {
    const payload = JSON.parse(readFileSync(join(dir, 'serper-organic.json'), 'utf8'));
    let apifyCalls = 0;
    let sosCalls = 0;
    const serper = new SerperCreditTracker();
    const ctx: LookupContext = {
      live: true,
      serper,
      serperEnabled: true,
      serperOrganic: payload,
      fetch: async () => {
        sosCalls += 1;
        throw new Error('SOS must not run after high-confidence Serper');
      },
      apifyFetchHtml: async () => {
        apifyCalls += 1;
        throw new Error('Apify must not run after high-confidence Serper');
      },
    };
    const result = await resolveSerperOwner(input, ctx);
    assert.equal(result.serper_credits, 2);
    assert.equal(serper.credits, 2);
    assert.ok(result.people.some((p) => isWaterfallReady(p)));
    const lookup = await resolveNameLookup(input, ctx);
    assert.equal(lookup.source, 'serper');
    assert.equal(lookup.people[0]?.confidence, 'high');
    assert.equal(apifyCalls, 0);
    assert.equal(sosCalls, 0);
  });

  it('covers unimplemented states via Serper without inventing SOS matches', async () => {
    const payload = JSON.parse(readFileSync(join(dir, 'serper-organic.json'), 'utf8'));
    payload.organic[0].snippet = 'Jane Sample is the President of ACME BUILDERS LLC in Houston, Texas.';
    payload.organic[0].title = 'ACME BUILDERS LLC — Jane Sample, President | OpenCorporates';
    const ctx: LookupContext = {
      live: false,
      serper: new SerperCreditTracker(),
      serperOrganic: payload,
    };
    const result = await resolveNameLookup(
      { company_name: 'ACME BUILDERS LLC', city: 'Houston', state: 'TX' },
      ctx,
    );
    assert.equal(result.source, 'serper');
    assert.equal(result.people[0]?.confidence, 'high');
    assert.equal(isWaterfallReady(result.people[0]!), true);
  });
});
