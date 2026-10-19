import { DESKTOP_UA } from '../http.js';
import type { LookupContext } from './context.js';
import { ctxSpend } from './context.js';
import {
  APIFY_USD_PER_BLOCKED_LOOKUP,
  apifyMaxUsdFromEnv,
  usdFromApifyRun,
} from './spend.js';

export const APIFY_PLAYWRIGHT_ACTOR = 'apify/playwright-scraper';
export const APIFY_PLAYWRIGHT_ACTOR_ID = 'apify~playwright-scraper';
export const APIFY_WEB_FETCH_ACTOR = 'apify/web-fetch';
export const APIFY_WEB_FETCH_ACTOR_ID = 'apify~web-fetch';
export const DZ_OMAR_BIZFILE_ACTOR = 'dz_omar/california-bizfile-scraper';
export const DZ_OMAR_BIZFILE_ACTOR_ID = 'dz_omar~california-bizfile-scraper';

/** Playwright pageFunction / requestHandler timeout for the sticky CA session. */
export const CA_BATCH_PAGE_FUNCTION_TIMEOUT_SECS = 600;
export const CA_BATCH_PAGE_LOAD_TIMEOUT_SECS = 180;
export const CA_BATCH_SESSION_POOL = 'ca_bizfile_sticky';
export const CA_BATCH_PROXY_SESSION = 'caBizfileSticky1';

const ALLOWED_ACTORS = new Set([APIFY_PLAYWRIGHT_ACTOR, APIFY_PLAYWRIGHT_ACTOR_ID, 'apify/web-scraper', 'apify~web-scraper']);
const HYBRID_ACTORS = new Set([
  APIFY_PLAYWRIGHT_ACTOR,
  APIFY_PLAYWRIGHT_ACTOR_ID,
  APIFY_WEB_FETCH_ACTOR,
  APIFY_WEB_FETCH_ACTOR_ID,
  DZ_OMAR_BIZFILE_ACTOR,
  DZ_OMAR_BIZFILE_ACTOR_ID,
  'apify/web-scraper',
  'apify~web-scraper',
]);

/** Apify waitForFinish max is 60s; longer runs are polled. */
const WAIT_FOR_FINISH_SEC = 60;
const POLL_MS = 4000;
const POLL_MAX_MS = 8 * 60 * 1000;
/** One sticky CA session can run for tens of minutes (hundreds of companies). */
export const CA_BATCH_POLL_MAX_MS = 45 * 60 * 1000;
const BATCH_SIZE = 20;
const BATCH_WAIT_MS = 80;

export class PaidDatasetForbiddenError extends Error {
  constructor(actor: string) {
    super(`Paid SOS datasets are forbidden; only ${APIFY_PLAYWRIGHT_ACTOR} HTML fallback is allowed (got ${actor})`);
    this.name = 'PaidDatasetForbiddenError';
  }
}

export function assertAllowedApifyActor(actor: string): void {
  if (!ALLOWED_ACTORS.has(actor)) throw new PaidDatasetForbiddenError(actor);
}

export function assertAllowedHybridActor(actor: string): void {
  if (!HYBRID_ACTORS.has(actor)) throw new PaidDatasetForbiddenError(actor);
}

const CA_BATCH_PRE_NAV = `[
  async (crawlingContext, gotoOptions) => {
    gotoOptions.timeout = ${CA_BATCH_PAGE_LOAD_TIMEOUT_SECS * 1000};
    gotoOptions.waitUntil = 'load';
    try {
      await crawlingContext.page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
      });
    } catch (e) {}
  },
]`;

const PAGE_FUNCTION = `async function pageFunction(context) {
  const html = await context.page.content();
  const text = await context.page.evaluate(() => document.body ? document.body.innerText : '');
  return { url: context.request.url, html, text };
}`;

/** Fetch URL bytes (PDF/image SI) as base64 after the browser has cookies. */
export const DOCUMENT_BYTES_PAGE_FUNCTION = `async function pageFunction(context) {
  const got = await context.page.evaluate(async (href) => {
    const r = await fetch(href, { credentials: 'include' });
    const ab = await r.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return { b64: btoa(binary), contentType: r.headers.get('content-type'), status: r.status };
  }, context.request.url);
  return {
    url: context.request.url,
    html: '',
    text: '',
    bytesBase64: got.b64,
    contentType: got.contentType,
    status: got.status,
  };
}`;

export interface ApifyHtmlResult {
  html: string;
  text: string;
  usd: number;
  cu: number;
  runId?: string;
  refused?: boolean;
  bytes?: Uint8Array;
  contentType?: string;
}

type RunData = {
  defaultDatasetId?: string;
  usageTotalUsd?: number;
  usage?: Record<string, number>;
  stats?: { computeUnits?: number; netRxBytes?: number; netTxBytes?: number };
  id?: string;
  status?: string;
};

async function apifyJson(url: string, init: RequestInit, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(url, init);
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    return { error: body.slice(0, 200), status: res.status };
  }
}

function emptyRefused(): ApifyHtmlResult {
  return { html: '', text: '', usd: 0, cu: 0, refused: true };
}

function capOf(ctx?: LookupContext): number | null {
  if (ctx?.apifyMaxUsd != null) return ctx.apifyMaxUsd;
  return apifyMaxUsdFromEnv();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runTerminal(status?: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(String(status || ''));
}

async function pollRun(
  runId: string,
  token: string,
  fetchFn: typeof fetch,
  pollMaxMs = POLL_MAX_MS,
): Promise<RunData | null> {
  const started = Date.now();
  let last: RunData | null = null;
  while (Date.now() - started < pollMaxMs) {
    const wrap = (await apifyJson(
      `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json', 'User-Agent': DESKTOP_UA } },
      fetchFn,
    )) as { data?: RunData };
    last = wrap?.data || null;
    if (runTerminal(last?.status)) return last;
    await sleep(POLL_MS);
  }
  return last;
}

interface BatchJob {
  url: string;
  resolve: (r: ApifyHtmlResult) => void;
  reject: (e: unknown) => void;
}

const batches = new WeakMap<object, Map<string, { jobs: BatchJob[]; timer: ReturnType<typeof setTimeout> | null; flushing: boolean }>>();

function batchKey(pageFunction: string): string {
  return pageFunction;
}

/**
 * Official-page HTML via apify/playwright-scraper + residential proxy.
 * Never paid Store officer datasets. Refused runs (no token, cap, failed start)
 * do not increment spend. Many startUrls share one actor run.
 */
export async function apifyFetchHtml(
  url: string,
  ctx?: LookupContext,
  opts?: { pageFunction?: string; immediate?: boolean; documentBytes?: boolean },
): Promise<ApifyHtmlResult> {
  if (ctx?.apifyFetchHtml) {
    const got = await ctx.apifyFetchHtml(url);
    if (got.refused) {
      ctxSpend(ctx).refuse();
      return emptyRefused();
    }
    if (got.usd > 0) ctxSpend(ctx).add(got.usd);
    const bytes = got.bytesBase64 ? Buffer.from(got.bytesBase64, 'base64') : undefined;
    return {
      html: got.html || '',
      text: got.text || '',
      usd: got.usd || 0,
      cu: 0,
      bytes,
      contentType: got.contentType,
    };
  }

  const token = ctx?.apifyToken?.trim();
  if (!token || ctx?.apifyEnabled === false) {
    ctxSpend(ctx).refuse();
    return emptyRefused();
  }

  const spend = ctxSpend(ctx);
  const cap = capOf(ctx);
  if (cap != null) spend.capUsd = cap;
  if (spend.wouldExceed(APIFY_USD_PER_BLOCKED_LOOKUP)) {
    spend.refuse();
    return emptyRefused();
  }

  const pageFunction = opts?.documentBytes ? DOCUMENT_BYTES_PAGE_FUNCTION : opts?.pageFunction || PAGE_FUNCTION;
  if (opts?.immediate || opts?.pageFunction || opts?.documentBytes) {
    const map = await runActorPages([url], ctx, token, pageFunction);
    return map.get(url) || emptyRefused();
  }

  return enqueueBatch(url, ctx, token, pageFunction);
}

function enqueueBatch(
  url: string,
  ctx: LookupContext | undefined,
  token: string,
  pageFunction: string,
): Promise<ApifyHtmlResult> {
  const host = ctx || { __solo: true };
  let byFn = batches.get(host);
  if (!byFn) {
    byFn = new Map();
    batches.set(host, byFn);
  }
  let bucket = byFn.get(batchKey(pageFunction));
  if (!bucket) {
    bucket = { jobs: [], timer: null, flushing: false };
    byFn.set(batchKey(pageFunction), bucket);
  }
  return new Promise((resolve, reject) => {
    bucket!.jobs.push({ url, resolve, reject });
    if (bucket!.jobs.length >= BATCH_SIZE) {
      if (bucket!.timer) clearTimeout(bucket!.timer);
      bucket!.timer = null;
      void flushBucket(bucket!, ctx, token, pageFunction);
    } else if (!bucket!.timer) {
      bucket!.timer = setTimeout(() => {
        bucket!.timer = null;
        void flushBucket(bucket!, ctx, token, pageFunction);
      }, BATCH_WAIT_MS);
    }
  });
}

async function flushBucket(
  bucket: { jobs: BatchJob[]; timer: ReturnType<typeof setTimeout> | null; flushing: boolean },
  ctx: LookupContext | undefined,
  token: string,
  pageFunction: string,
): Promise<void> {
  if (bucket.flushing) return;
  const jobs = bucket.jobs.splice(0, bucket.jobs.length);
  if (!jobs.length) return;
  bucket.flushing = true;
  try {
    const urls = jobs.map((j) => j.url);
    const map = await runActorPages(urls, ctx, token, pageFunction);
    for (const job of jobs) {
      job.resolve(map.get(job.url) || emptyRefused());
    }
  } catch (err) {
    for (const job of jobs) job.reject(err);
  } finally {
    bucket.flushing = false;
    if (bucket.jobs.length) void flushBucket(bucket, ctx, token, pageFunction);
  }
}

async function runActorPages(
  urls: string[],
  ctx: LookupContext | undefined,
  token: string,
  pageFunction: string,
): Promise<Map<string, ApifyHtmlResult>> {
  const out = new Map<string, ApifyHtmlResult>();
  const unique = [...new Set(urls.filter(Boolean))];
  if (!unique.length) return out;

  const spend = ctxSpend(ctx);
  if (spend.wouldExceed(APIFY_USD_PER_BLOCKED_LOOKUP)) {
    spend.refuse();
    for (const url of unique) out.set(url, emptyRefused());
    return out;
  }

  assertAllowedApifyActor(APIFY_PLAYWRIGHT_ACTOR);
  const fetchFn = (ctx?.fetch as typeof fetch) ?? fetch;
  const start = `https://api.apify.com/v2/acts/${APIFY_PLAYWRIGHT_ACTOR_ID}/runs?token=${encodeURIComponent(token)}&waitForFinish=${WAIT_FOR_FINISH_SEC}`;
  const input = {
    startUrls: unique.map((url) => ({ url })),
    keepUrlFragments: false,
    linkSelector: '',
    globs: [],
    pageFunction,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    proxyRotation: 'RECOMMENDED',
    maxConcurrency: 2,
    maxRequestRetries: 2,
    downloadMedia: false,
    downloadCss: false,
    closeCookieModals: true,
    waitUntil: 'networkidle',
    initialCookies: [],
  };

  let run: RunData | undefined;
  try {
    const runWrap = (await apifyJson(
      start,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': DESKTOP_UA },
        body: JSON.stringify(input),
      },
      fetchFn,
    )) as { data?: RunData };
    run = runWrap?.data;
  } catch {
    spend.refuse();
    for (const url of unique) out.set(url, emptyRefused());
    return out;
  }

  if (!run?.id && !run?.defaultDatasetId) {
    spend.refuse();
    for (const url of unique) out.set(url, emptyRefused());
    return out;
  }

  if (run?.id && !runTerminal(run.status)) {
    const polled = await pollRun(run.id, token, fetchFn);
    if (polled) run = { ...run, ...polled };
  }

  const succeeded = run?.status === 'SUCCEEDED';
  const cost = usdFromApifyRun(run, { succeeded });
  if (cost.usd > 0 || cost.cu > 0 || cost.proxyGb > 0) {
    spend.add(cost.usd, { cu: cost.cu, lookups: unique.length, proxyGb: cost.proxyGb });
  } else if (!succeeded) {
    spend.refuse();
  }

  const datasetId = run?.defaultDatasetId;
  if (!datasetId || !succeeded) {
    for (const url of unique) {
      out.set(url, {
        html: '',
        text: '',
        usd: cost.usd,
        cu: cost.cu,
        runId: run?.id,
        refused: !succeeded,
      });
    }
    return out;
  }

  const itemsWrap = (await apifyJson(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true`,
    { headers: { Accept: 'application/json', 'User-Agent': DESKTOP_UA } },
    fetchFn,
  )) as Array<{ url?: string; html?: string; text?: string; bytesBase64?: string; contentType?: string }>;
  const items = Array.isArray(itemsWrap) ? itemsWrap : [];
  const perUrl = new Map<string, (typeof items)[0]>();
  for (const row of items) {
    if (row?.url) perUrl.set(row.url, row);
  }
  let i = 0;
  for (const url of unique) {
    const row = perUrl.get(url) || items[i++];
    const bytes = row?.bytesBase64 ? Buffer.from(row.bytesBase64, 'base64') : undefined;
    out.set(url, {
      html: String(row?.html || ''),
      text: String(row?.text || ''),
      usd: cost.usd,
      cu: cost.cu,
      runId: run?.id,
      bytes,
      contentType: row?.contentType,
    });
  }
  return out;
}

export interface PlaywrightActorStartUrl {
  url: string;
  userData?: Record<string, unknown>;
}

export interface PlaywrightActorRunResult {
  items: Array<Record<string, unknown>>;
  run: RunData | null;
  refused: boolean;
  succeeded: boolean;
  usd: number;
  cu: number;
  proxyGb: number;
  runId?: string;
}

function emptyActorRun(refused = true): PlaywrightActorRunResult {
  return { items: [], run: null, refused, succeeded: false, usd: 0, cu: 0, proxyGb: 0 };
}

/**
 * One playwright-scraper run with caller-supplied startUrls (including userData)
 * and pageFunction. Sticky residential proxy. Used by the CA batch session.
 */
export async function runPlaywrightActor(
  ctx: LookupContext | undefined,
  opts: {
    startUrls: PlaywrightActorStartUrl[];
    pageFunction: string;
    pollMaxMs?: number;
    maxConcurrency?: number;
    proxyRotation?: 'RECOMMENDED' | 'UNTIL_FAILURE' | 'PER_REQUEST';
    maxRequestsPerCrawl?: number;
    estimateUsd?: number;
    lookups?: number;
  },
): Promise<PlaywrightActorRunResult> {
  const token = ctx?.apifyToken?.trim();
  if (!token || ctx?.apifyEnabled === false) {
    ctxSpend(ctx).refuse();
    return emptyActorRun(true);
  }
  const spend = ctxSpend(ctx);
  const cap = capOf(ctx);
  if (cap != null) spend.capUsd = cap;
  if (spend.wouldExceed(opts.estimateUsd ?? APIFY_USD_PER_BLOCKED_LOOKUP)) {
    spend.refuse();
    return emptyActorRun(true);
  }
  if (!opts.startUrls.length || !opts.pageFunction) {
    spend.refuse();
    return emptyActorRun(true);
  }

  assertAllowedApifyActor(APIFY_PLAYWRIGHT_ACTOR);
  const fetchFn = (ctx?.fetch as typeof fetch) ?? fetch;
  const start = `https://api.apify.com/v2/acts/${APIFY_PLAYWRIGHT_ACTOR_ID}/runs?token=${encodeURIComponent(token)}&waitForFinish=${WAIT_FOR_FINISH_SEC}`;
  const input = {
    startUrls: opts.startUrls,
    keepUrlFragments: false,
    linkSelector: '',
    globs: [],
    pageFunction: opts.pageFunction,
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'US',
    },
    proxyRotation: opts.proxyRotation || 'UNTIL_FAILURE',
    sessionPoolName: CA_BATCH_SESSION_POOL,
    maxConcurrency: opts.maxConcurrency ?? 1,
    maxRequestRetries: 0,
    maxRequestsPerCrawl: opts.maxRequestsPerCrawl ?? 1,
    maxPagesPerCrawl: 1,
    downloadMedia: false,
    downloadCss: true,
    closeCookieModals: false,
    maxScrollHeightPixels: 0,
    waitUntil: 'load',
    pageLoadTimeoutSecs: CA_BATCH_PAGE_LOAD_TIMEOUT_SECS,
    pageFunctionTimeoutSecs: CA_BATCH_PAGE_FUNCTION_TIMEOUT_SECS,
    requestHandlerTimeoutSecs: CA_BATCH_PAGE_FUNCTION_TIMEOUT_SECS,
    navigationTimeoutSecs: CA_BATCH_PAGE_LOAD_TIMEOUT_SECS,
    useChrome: true,
    headless: false,
    launcher: 'chromium',
    preNavigationHooks: CA_BATCH_PRE_NAV,
    debugLog: Boolean(ctx?.caBatchDebug),
    customData: { sessionId: CA_BATCH_PROXY_SESSION },
    initialCookies: [],
  };

  let run: RunData | undefined;
  try {
    const runWrap = (await apifyJson(
      start,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': DESKTOP_UA },
        body: JSON.stringify(input),
      },
      fetchFn,
    )) as { data?: RunData };
    run = runWrap?.data;
  } catch {
    spend.refuse();
    return emptyActorRun(true);
  }

  if (!run?.id && !run?.defaultDatasetId) {
    spend.refuse();
    return emptyActorRun(true);
  }

  if (run?.id && !runTerminal(run.status)) {
    const polled = await pollRun(run.id, token, fetchFn, opts.pollMaxMs ?? POLL_MAX_MS);
    if (polled) run = { ...run, ...polled };
  }

  const succeeded = run?.status === 'SUCCEEDED';
  const cost = usdFromApifyRun(run, { succeeded });
  if (cost.usd > 0 || cost.cu > 0 || cost.proxyGb > 0) {
    spend.add(cost.usd, { cu: cost.cu, lookups: opts.lookups ?? opts.startUrls.length, proxyGb: cost.proxyGb });
  } else if (!succeeded) {
    spend.refuse();
  }

  const datasetId = run?.defaultDatasetId;
  let items: Array<Record<string, unknown>> = [];
  if (datasetId) {
    const itemsWrap = await apifyJson(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true`,
      { headers: { Accept: 'application/json', 'User-Agent': DESKTOP_UA } },
      fetchFn,
    );
    if (Array.isArray(itemsWrap)) items = itemsWrap as Array<Record<string, unknown>>;
  }

  return {
    items,
    run: run || null,
    refused: !succeeded && items.length === 0,
    succeeded,
    usd: cost.usd,
    cu: cost.cu,
    proxyGb: cost.proxyGb,
    runId: run?.id,
  };
}

/** Named Apify actor (web-fetch, dz_omar CA bizfile). Enforces the hybrid allow-list. */
export async function runApifyActorRaw(
  ctx: LookupContext | undefined,
  opts: {
    actorId: string;
    input: Record<string, unknown>;
    estimateUsd?: number;
    lookups?: number;
    pollMaxMs?: number;
  },
): Promise<PlaywrightActorRunResult> {
  const token = ctx?.apifyToken?.trim();
  if (!token || ctx?.apifyEnabled === false) {
    ctxSpend(ctx).refuse();
    return emptyActorRun(true);
  }
  const spend = ctxSpend(ctx);
  const cap = capOf(ctx);
  if (cap != null) spend.capUsd = cap;
  if (spend.wouldExceed(opts.estimateUsd ?? APIFY_USD_PER_BLOCKED_LOOKUP)) {
    spend.refuse();
    return emptyActorRun(true);
  }
  assertAllowedHybridActor(opts.actorId.includes('~') ? opts.actorId.replace('~', '/') : opts.actorId);
  const fetchFn = (ctx?.fetch as typeof fetch) ?? fetch;
  const actorId = opts.actorId.includes('~') ? opts.actorId : opts.actorId.replace('/', '~');
  const start = `https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(token)}&waitForFinish=${WAIT_FOR_FINISH_SEC}`;

  let run: RunData | undefined;
  try {
    const runWrap = (await apifyJson(
      start,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': DESKTOP_UA },
        body: JSON.stringify(opts.input),
      },
      fetchFn,
    )) as { data?: RunData };
    run = runWrap?.data;
  } catch {
    spend.refuse();
    return emptyActorRun(true);
  }

  if (!run?.id && !run?.defaultDatasetId) {
    spend.refuse();
    return emptyActorRun(true);
  }

  if (run?.id && !runTerminal(run.status)) {
    const polled = await pollRun(run.id, token, fetchFn, opts.pollMaxMs ?? POLL_MAX_MS);
    if (polled) run = { ...run, ...polled };
  }

  const succeeded = run?.status === 'SUCCEEDED';
  const cost = usdFromApifyRun(run, { succeeded });
  if (cost.usd > 0 || cost.cu > 0 || cost.proxyGb > 0) {
    spend.add(cost.usd, { cu: cost.cu, lookups: opts.lookups ?? 1, proxyGb: cost.proxyGb });
  } else if (!succeeded) {
    spend.refuse();
  }

  const datasetId = run?.defaultDatasetId;
  let items: Array<Record<string, unknown>> = [];
  if (datasetId) {
    const itemsWrap = await apifyJson(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true`,
      { headers: { Accept: 'application/json', 'User-Agent': DESKTOP_UA } },
      fetchFn,
    );
    if (Array.isArray(itemsWrap)) items = itemsWrap as Array<Record<string, unknown>>;
  }

  return {
    items,
    run: run || null,
    refused: !succeeded && items.length === 0,
    succeeded,
    usd: cost.usd,
    cu: cost.cu,
    proxyGb: cost.proxyGb,
    runId: run?.id,
  };
}
