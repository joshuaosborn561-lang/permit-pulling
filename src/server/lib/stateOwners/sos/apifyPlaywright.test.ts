import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertAllowedApifyActor,
  assertAllowedHybridActor,
  apifyFetchHtml,
  PaidDatasetForbiddenError,
} from './apifyPlaywright.js';
import { ApifySpendTracker } from './spend.js';

describe('Apify policy', () => {
  it('allows playwright-scraper and forbids paid officer datasets', () => {
    assert.doesNotThrow(() => assertAllowedApifyActor('apify/playwright-scraper'));
    assert.throws(() => assertAllowedApifyActor('open-sos-data/officers'), PaidDatasetForbiddenError);
  });

  it('allows the CA hybrid actors (dz_omar search+history, web-fetch SI PDF)', () => {
    assert.doesNotThrow(() => assertAllowedHybridActor('dz_omar/california-bizfile-scraper'));
    assert.doesNotThrow(() => assertAllowedHybridActor('apify/web-fetch'));
    assert.throws(() => assertAllowedHybridActor('open-sos-data/officers'), PaidDatasetForbiddenError);
  });

  it('does not count spend on refused runs', async () => {
    const spend = new ApifySpendTracker();
    const got = await apifyFetchHtml('https://example.test', {
      live: true,
      apifyEnabled: false,
      spend,
    });
    assert.equal(got.refused, true);
    assert.equal(got.usd, 0);
    assert.equal(spend.usd, 0);
    assert.ok(spend.refused >= 1);
  });

  it('refuses new runs at APIFY_MAX_USD without charging', async () => {
    const spend = new ApifySpendTracker();
    spend.capUsd = 0;
    const got = await apifyFetchHtml('https://example.test', {
      live: true,
      apifyToken: 'token',
      apifyMaxUsd: 0,
      spend,
    });
    assert.equal(got.refused, true);
    assert.equal(spend.usd, 0);
  });

  it('batches many lookups into one actor run and polls past waitForFinish', async () => {
    const spend = new ApifySpendTracker();
    let runPosts = 0;
    let polled = false;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/acts/') && init?.method === 'POST') {
        runPosts += 1;
        const body = JSON.parse(String(init.body || '{}')) as { startUrls?: Array<{ url: string }> };
        assert.ok((body.startUrls || []).length >= 2);
        return new Response(
          JSON.stringify({
            data: {
              id: 'run-1',
              status: 'RUNNING',
              defaultDatasetId: 'ds-1',
              usageTotalUsd: 0.02,
              stats: { computeUnits: 0.1 },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/actor-runs/run-1')) {
        polled = true;
        return new Response(
          JSON.stringify({
            data: {
              id: 'run-1',
              status: 'SUCCEEDED',
              defaultDatasetId: 'ds-1',
              usageTotalUsd: 0.02,
              stats: { computeUnits: 0.1 },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/datasets/ds-1/items')) {
        return new Response(
          JSON.stringify([
            { url: 'https://example.test/a', html: '<html>a</html>' },
            { url: 'https://example.test/b', html: '<html>b</html>' },
          ]),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('nope', { status: 404 });
    };
    const ctx = { live: true, apifyToken: 'token', spend, fetch: fetchFn };
    const [a, b] = await Promise.all([
      apifyFetchHtml('https://example.test/a', ctx),
      apifyFetchHtml('https://example.test/b', ctx),
    ]);
    assert.equal(runPosts, 1);
    assert.equal(polled, true);
    assert.equal(a.html.includes('a'), true);
    assert.equal(b.html.includes('b'), true);
    assert.equal(spend.runs, 1);
    assert.equal(spend.lookups, 2);
    assert.ok(spend.usd > 0);
  });

  it('does not apply the per-lookup estimate to a failed run with no usage', async () => {
    const spend = new ApifySpendTracker();
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/acts/') && init?.method === 'POST') {
        return new Response(JSON.stringify({ data: { id: 'run-fail', status: 'FAILED' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/actor-runs/run-fail')) {
        return new Response(JSON.stringify({ data: { id: 'run-fail', status: 'FAILED' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    };
    const got = await apifyFetchHtml(
      'https://example.test/x',
      { live: true, apifyToken: 'token', spend, fetch: fetchFn },
      { immediate: true },
    );
    assert.equal(got.usd, 0);
    assert.equal(spend.usd, 0);
  });
});
