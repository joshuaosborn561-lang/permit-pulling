import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { LookupContext } from './context.js';
import { resolveNameLookup } from './namePath.js';
import { parseOfficerRoster } from './officers.js';
import {
  blobHasState,
  companyTiedToBlob,
  officersFromSerperBlob,
  resolveSerperOwner,
  scoreSerperOrganic,
  serperOfficerQuery,
  serperQueriesFor,
  serperSiteQueries,
  SERPER_COMPANY_TRIGRAM,
} from './serperOwners.js';
import { SerperCreditTracker } from './spend.js';
import { isWaterfallReady } from './waterfall.js';
import type { SerperSearchResponse } from './types.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function json(name: string): SerperSearchResponse {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as SerperSearchResponse;
}

describe('serper owner tier', () => {
  const input = { company_name: 'ACME BUILDERS LLC', city: 'Oakland', state: 'CA' };

  it('issues separate per-site queries including sunbiz.org, never a combined site: OR', () => {
    const q = serperOfficerQuery(input);
    assert.match(q, /ACME BUILDERS LLC/);
    assert.match(q, /Oakland/);
    assert.match(q, /officer OR owner OR CEO OR president OR manager/);
    const sites = serperSiteQueries(input);
    assert.equal(sites.some((s) => /\bOR\s+site:/i.test(s)), false);
    assert.ok(sites.some((s) => s.startsWith('site:opencorporates.com')));
    assert.ok(sites.some((s) => s.startsWith('site:bizapedia.com')));
    assert.ok(sites.some((s) => s.startsWith('site:sunbiz.org')));
    assert.ok(sites.some((s) => s.startsWith('site:bizfileonline.sos.ca.gov')));
    assert.equal(serperQueriesFor(input).length, 1 + sites.length);
  });

  it('accepts a high-confidence OpenCorporates snippet tied to company + city + state', () => {
    const payload = json('serper-organic.json');
    const cand = scoreSerperOrganic(input, payload.organic![0]);
    assert.ok(cand);
    assert.equal(cand?.confidence, 'high');
    assert.ok((cand?.score || 0) >= 0.8);
    assert.match(cand?.entry.name || '', /Jane Sample/i);
  });

  it('does not capture review-text names from a real-style Serper snippet', () => {
    const payload = json('serper-garbled-review.json');
    const blob = `${payload.organic![0].title}\n${payload.organic![0].snippet}`;
    const names = officersFromSerperBlob(blob, input.company_name, input).map((r) => r.name.toLowerCase());
    assert.equal(names.some((n) => n.includes('was easy') || n.includes('easy and')), false);
    assert.equal(scoreSerperOrganic(input, payload.organic![0]), null);
  });

  it('rejects AND COACH X and CA X fragments from a real-style snippet', () => {
    const payload = json('serper-and-coach.json');
    const blob = `${payload.organic![0].title}\n${payload.organic![0].snippet}`;
    const names = officersFromSerperBlob(blob, input.company_name, input).map((r) => r.name.toLowerCase());
    assert.equal(names.some((n) => /\band\b/.test(n) || n.includes('coach') || n === 'ca x'), false);
    assert.equal(parseOfficerRoster(blob).some((r) => /and coach|ca x/i.test(r.name)), false);
  });

  it('never treats Detail Name as a person and prefers the labeled officer', () => {
    const payload = json('serper-detail-name.json');
    const cand = scoreSerperOrganic(input, payload.organic![0]);
    assert.ok(cand);
    assert.equal(/detail/i.test(cand?.entry.name || ''), false);
    assert.match(cand?.entry.name || '', /Jane Sample|SAMPLE,\s*JANE/i);
    assert.equal(cand?.entry.labeled, true);
    assert.equal(cand?.confidence, 'high');
  });

  it('allows high confidence from owner/founder/president + exact company + city on a non-trusted host', () => {
    const payload = json('serper-untrusted-owner.json');
    const cand = scoreSerperOrganic(input, payload.organic![0]);
    assert.ok(cand);
    assert.equal(cand?.trusted, false);
    assert.equal(cand?.confidence, 'high');
    assert.match(cand?.entry.name || '', /Jane Sample/i);
    assert.equal(
      isWaterfallReady({
        first_name: 'Jane',
        last_name: 'Sample',
        title: cand!.entry.title,
        company_name: input.company_name,
        domain: null,
        source_url: cand!.source_url,
        confidence: cand!.confidence,
        confidence_score: cand!.score,
        state: 'CA',
        source: 'serper',
        role: 'owner',
        coverage_reason: null,
      }),
      true,
    );
  });

  it('treats sunbiz.org as trusted and skips the Detail Name label', () => {
    const payload = json('serper-sunbiz.json');
    const cand = scoreSerperOrganic(
      { company_name: 'ACME BUILDERS LLC', city: 'Oakland', state: 'FL' },
      payload.organic![0],
    );
    assert.ok(cand);
    assert.equal(cand?.trusted, true);
    assert.equal(/detail/i.test(cand?.entry.name || ''), false);
    assert.match(cand?.entry.name || '', /SAMPLE,\s*JANE|Jane Sample/i);
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

  it('requires city or state in the snippet and a tighter company trigram', () => {
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
    assert.equal(SERPER_COMPANY_TRIGRAM > 0.48, true);
    assert.equal(companyTiedToBlob('ACME BUILDERS LLC', 'some other plumbing outfit nearby'), null);
  });

  it('marks medium-confidence directory hits without city not waterfall-ready', () => {
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

  it('uses the OpenCorporates-only payload when the generic query is garbled', async () => {
    const garbled = json('serper-garbled-review.json');
    const oc = json('serper-organic.json');
    const serper = new SerperCreditTracker();
    const ctx: LookupContext = {
      live: true,
      serper,
      serperEnabled: true,
      serperOrganic: (q) => (q.startsWith('site:opencorporates.com') ? oc : garbled),
      fetch: async () => {
        throw new Error('SOS must not run after high-confidence Serper');
      },
      apifyFetchHtml: async () => {
        throw new Error('Apify must not run after high-confidence Serper');
      },
    };
    const result = await resolveSerperOwner(input, ctx);
    assert.equal(result.serper_credits, serperQueriesFor(input).length);
    assert.ok(result.people.some((p) => isWaterfallReady(p)));
    assert.match(result.people[0]?.first_name || '', /Jane/i);
    const lookup = await resolveNameLookup(input, ctx);
    assert.equal(lookup.source, 'serper');
    assert.equal(lookup.people[0]?.confidence, 'high');
  });

  it('covers unimplemented states via Serper without inventing SOS matches', async () => {
    const payload = json('serper-organic.json');
    payload.organic![0].snippet = 'Jane Sample is the President of ACME BUILDERS LLC in Houston, Texas.';
    payload.organic![0].title = 'ACME BUILDERS LLC — Jane Sample, President | OpenCorporates';
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
