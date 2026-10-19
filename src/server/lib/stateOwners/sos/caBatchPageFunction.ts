import {
  CA_BATCH_HISTORY_PATH,
  CA_BATCH_IMAGE_PATH,
  CA_BATCH_MIN_TRIGRAM,
  CA_BATCH_OCR_MIN_CHARS,
  CA_BATCH_SEARCH_PATH,
  CA_BATCH_UI,
  caBatchAsRecord,
  caBatchEntityCity,
  caBatchExtractPdfText,
  caBatchIsChallenge,
  caBatchIsWafBlock,
  caBatchLatestSiDocumentId,
  caBatchMapRow,
  caBatchNestedAgent,
  caBatchNestedCity,
  caBatchNormalizeName,
  caBatchCoreSearchName,
  caBatchParseJson,
  caBatchPickEntity,
  caBatchPickString,
  caBatchRowsFromPayload,
  caBatchSourceUrl,
  caBatchSplitDba,
  caBatchTextNeedsOcr,
  caBatchTrigram,
  caBatchUnescapePdf,
} from './caBatchLogic.js';
import { CA_BATCH_ITEM_RETRIES } from './spend.js';

/**
 * Apify playwright-scraper evals pageFunction as an expression (`(fn)`), so
 * the source MUST be a single function — top-level `const` is a SyntaxError.
 * Helpers are injected inside the function body.
 *
 * Search is driven through the real bizfileOnline UI (type + submit) and the
 * SPA's own network response. Direct page.evaluate fetch() is 429/errorCode 15.
 */
async function pageFunction(context: {
  page: any;
  request: { userData?: { companies?: Array<{ company_name: string; city?: string | null }>; debug?: boolean } };
  pushData: (item: unknown) => Promise<void>;
  log?: { info?: (m: string) => void };
}): Promise<{ processed: number; blocked: boolean }> {
  const page = context.page;
  const userData = (context.request && context.request.userData) || {};
  const companies = userData.companies || [];
  const debug = Boolean(userData.debug);
  const retriesCap = CA_BATCH_ITEM_RETRIES;
  const log = context.log;

  function jitter(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function dbg(
    steps: Array<Record<string, unknown>>,
    step: string,
    extra?: Record<string, unknown>,
  ): void {
    const row = Object.assign({ step }, extra || {});
    steps.push(row);
    if (debug && log && typeof log.info === 'function') {
      log.info('[ca-batch] ' + JSON.stringify(row));
    }
  }

  function errorCodeOf(text: string): number | undefined {
    const m = String(text || '').match(/errorCode["']?\s*[:=]\s*"?(\d+)/i);
    return m ? Number(m[1]) : undefined;
  }

  async function visibleLocator(selectors: string[]): Promise<any> {
    for (let i = 0; i < selectors.length; i++) {
      try {
        const loc = page.locator(selectors[i]).first();
        const n = await loc.count();
        if (n > 0 && (await loc.isVisible())) return loc;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  function pageLooksBlocked(html: string): boolean {
    const text = String(html || '');
    if (caBatchIsWafBlock(0, text) || caBatchIsChallenge(text)) return true;
    const compact = text.replace(/\s+/g, '');
    return compact.length > 0 && compact.length < 1200;
  }

  async function findSearchInput(): Promise<any> {
    try {
      const byPh = page.getByPlaceholder(/search by name or file number/i).first();
      if ((await byPh.count()) > 0 && (await byPh.isVisible())) return byPh;
    } catch {
      /* CSS fallback */
    }
    try {
      const byRole = page.getByRole('textbox', { name: /search by name or file number/i }).first();
      if ((await byRole.count()) > 0 && (await byRole.isVisible())) return byRole;
    } catch {
      /* CSS fallback */
    }
    try {
      const combo = page.getByRole('combobox', { name: /search/i }).first();
      if ((await combo.count()) > 0 && (await combo.isVisible())) return combo;
    } catch {
      /* CSS fallback */
    }
    return visibleLocator([
      'input[placeholder*="Search by name or file number" i]',
      'input[placeholder*="Search" i]',
      'input[aria-label*="Search" i]',
      '[role="combobox"]',
      '[role="searchbox"]',
      'input[type="search"]',
      'input[name="search"]',
      'input[type="text"]',
      '.search input',
      'input.form-control',
    ]);
  }

  async function waitClear(): Promise<boolean> {
    await page.waitForTimeout(jitter(8000, 12000));
    for (let i = 0; i < 3; i++) {
      const html = await page.content();
      if (pageLooksBlocked(html)) {
        await page.waitForTimeout(jitter(30000, 60000));
        try {
          await page.goto(CA_BATCH_UI, { waitUntil: 'load', timeout: 180000 });
        } catch {
          /* keep waiting */
        }
        await page.waitForTimeout(jitter(8000, 12000));
        continue;
      }
      const input = await findSearchInput();
      if (input) return true;
      try {
        await page.waitForSelector(
          'input[placeholder*="Search" i], input[placeholder*="file number" i], [role="combobox"], [role="searchbox"]',
          { timeout: 15000 },
        );
        const again = await findSearchInput();
        if (again) return true;
      } catch {
        /* not hydrated yet */
      }
      await page.waitForTimeout(jitter(2000, 4000));
    }
    const last = await page.content();
    if (pageLooksBlocked(last)) return false;
    return Boolean(await findSearchInput());
  }

  async function reclear(): Promise<boolean> {
    await page.waitForTimeout(jitter(30000, 60000));
    try {
      await page.goto(CA_BATCH_UI, { waitUntil: 'load', timeout: 180000 });
    } catch {
      /* still try waitClear */
    }
    return waitClear();
  }

  async function readResponse(resp: any): Promise<{ status: number; text: string; latin1: string; contentType: string }> {
    if (!resp) return { status: 0, text: '', latin1: '', contentType: '' };
    const status = Number(resp.status ? resp.status() : 0);
    let text = '';
    let latin1 = '';
    try {
      const buf = await resp.body();
      const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
      latin1 = bytes.toString('latin1');
      text = bytes.toString('utf8');
    } catch {
      try {
        text = await resp.text();
        latin1 = text;
      } catch {
        /* empty */
      }
    }
    let contentType = '';
    try {
      const headers = resp.headers ? resp.headers() : {};
      contentType = headers['content-type'] || headers['Content-Type'] || '';
    } catch {
      /* ignore */
    }
    return { status, text, latin1, contentType };
  }

  async function waitUrl(fragment: string, timeout: number): Promise<any> {
    const needle = String(fragment || '').toLowerCase();
    return page
      .waitForResponse(
        function (r: { url: () => string }) {
          return String(r.url() || '').toLowerCase().indexOf(needle) >= 0;
        },
        { timeout: timeout },
      )
      .catch(function () {
        return null;
      });
  }

  async function readSearchDom(): Promise<{ html: string; payload: unknown; entities: Array<Record<string, string>> }> {
    try {
      await page.waitForTimeout(jitter(400, 900));
      return await page.evaluate(function () {
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        let payload = null;
        const scripts = document.querySelectorAll('script');
        for (let i = 0; i < scripts.length; i++) {
          const t = scripts[i].textContent || '';
          if (t.indexOf('EntityData') >= 0 || t.indexOf('ENTITY_NAME') >= 0) {
            const start = t.search(/[\[{]/);
            if (start >= 0) {
              try {
                payload = JSON.parse(t.slice(start));
              } catch (e) {
                /* ignore */
              }
            }
          }
        }
        const entities = [];
        const trs = document.querySelectorAll('table tbody tr, [role="row"]');
        for (let i = 0; i < trs.length; i++) {
          const cells = trs[i].querySelectorAll('td, [role="gridcell"]');
          const texts = [];
          for (let j = 0; j < cells.length; j++) {
            texts.push(String(cells[j].textContent || '').replace(/\s+/g, ' ').trim());
          }
          const blob = texts.join(' | ') || String(trs[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (!blob || blob.length < 3) continue;
          const idMatch = blob.match(/\b(\d{10,16}|[A-Z]\d{6,8})\b/);
          entities.push({
            EntityName: texts[0] || blob.split('|')[0].trim(),
            EntityID: idMatch ? idMatch[1] : '',
            EntityCity: texts[2] || texts[1] || '',
          });
        }
        return { html: html.slice(0, 120000), payload: payload, entities: entities };
      });
    } catch {
      return { html: '', payload: null, entities: [] };
    }
  }

  async function ensureSearchPage(steps: Array<Record<string, unknown>>): Promise<boolean> {
    try {
      await page.goto(CA_BATCH_UI, { waitUntil: 'load', timeout: 180000 });
    } catch {
      /* waitClear */
    }
    const ok = await waitClear();
    dbg(steps, 'search_page', { status: ok ? 200 : 0, error: ok ? undefined : 'incapsula_not_cleared' });
    return ok;
  }

  async function searchViaUi(name: string, steps: Array<Record<string, unknown>>) {
    const html = await page.content();
    dbg(steps, 'pre_search', { status: pageLooksBlocked(html) ? 429 : 200, bytes: html.length });
    if (pageLooksBlocked(html)) {
      dbg(steps, 'search_input', { status: 429, error: 'block_page_before_search' });
      return { status: 429, text: html.slice(0, 4000), latin1: html.slice(0, 4000), contentType: 'text/html' };
    }
    const input = await findSearchInput();
    if (!input) {
      dbg(steps, 'search_input', { status: 0, error: 'search_input_missing', bytes: html.length });
      return { status: 0, text: '', latin1: '', contentType: '' };
    }
    const pending = waitUrl('businesssearch', 45000);
    try {
      await input.click({ clickCount: 3 });
    } catch {
      await input.click();
    }
    await page.waitForTimeout(jitter(80, 200));
    try {
      await input.fill('');
    } catch {
      /* type over */
    }
    await input.type(name, { delay: jitter(45, 100) });
    await page.waitForTimeout(jitter(280, 750));
    const btn = await visibleLocator([
      'button[aria-label*="Execute search" i]',
      'button:has-text("Execute search")',
      '[aria-label*="Execute search" i]',
      'button:has-text("Search")',
      'button:has-text("SEARCH")',
      '[role="button"]:has-text("Search")',
      'button[type="submit"]',
      'input[type="submit"]',
    ]);
    if (btn) await btn.click();
    else await page.keyboard.press('Enter');
    const resp = await pending;
    const got = await readResponse(resp);
    dbg(steps, 'search', {
      status: got.status,
      errorCode: errorCodeOf(got.text),
      bytes: (got.text || '').length,
    });
    return got;
  }

  async function historyViaUi(
    entityId: string,
    entityName: string,
    steps: Array<Record<string, unknown>>,
  ) {
    const pendingHist = waitUrl('History/business', 40000);
    const pendingDetail = waitUrl('FilingDetail/business', 40000);
    const clickables = [entityId, entityName].filter(Boolean);
    let clicked = false;
    for (let i = 0; i < clickables.length; i++) {
      const loc = await visibleLocator(['text=' + clickables[i]]);
      if (loc) {
        await loc.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      const first = await visibleLocator([
        'table tbody tr a',
        'table tbody tr',
        '[role="row"] a',
        '[role="row"]',
        '.ag-row',
      ]);
      if (first) {
        await first.click();
        clicked = true;
      }
    }
    await page.waitForTimeout(jitter(400, 900));
    const viewHist = await visibleLocator([
      'text=View History',
      'button:has-text("History")',
      'a:has-text("History")',
    ]);
    if (viewHist) await viewHist.click();
    const resp = (await pendingHist) || (await pendingDetail);
    const got = await readResponse(resp);
    dbg(steps, 'history', {
      status: got.status,
      errorCode: errorCodeOf(got.text),
      bytes: (got.text || '').length,
      clicked: clicked,
    });
    return got;
  }

  async function siViaUi(steps: Array<Record<string, unknown>>) {
    const pending = waitUrl('GetImageByNum', 40000);
    const link = await visibleLocator([
      'a[href*="GetImageByNum"]',
      'text=Statement of Information',
      'text=SI-550',
      'text=LLC-12',
    ]);
    if (link) await link.click();
    const resp = await pending;
    const got = await readResponse(resp);
    dbg(steps, 'si_pdf', {
      status: got.status,
      errorCode: errorCodeOf(got.latin1 || got.text),
      bytes: (got.latin1 || '').length,
      clicked: Boolean(link),
    });
    return got;
  }

  const cleared = await waitClear();
  if (!cleared) {
    for (const company of companies) {
      await context.pushData({
        company_name: company.company_name,
        city: company.city || '',
        state: 'CA',
        status: 'blocked',
        retries: 0,
        error: 'incapsula_not_cleared',
        debug_steps: [{ step: 'incapsula', status: 0, error: 'incapsula_not_cleared' }],
      });
    }
    return { processed: 0, blocked: true };
  }

  let processed = 0;
  for (const company of companies) {
    if (processed > 0) await page.waitForTimeout(jitter(900, 2400));
    let lastError = '';
    const steps: Array<Record<string, unknown>> = [];
    let item: Record<string, unknown> = {
      company_name: company.company_name,
      city: company.city || '',
      state: 'CA',
      status: 'error',
      retries: 0,
    };
    for (let attempt = 0; attempt < retriesCap; attempt++) {
      item.retries = attempt;
      try {
        if (attempt > 0) await page.waitForTimeout(jitter(2500, 6000));
        if (processed > 0 || attempt > 0) {
          const landed = await ensureSearchPage(steps);
          if (!landed) {
            lastError = 'incapsula_not_cleared';
            item.status = 'blocked';
            item.error = lastError;
            continue;
          }
        }
        const search = await searchViaUi(caBatchCoreSearchName(company.company_name) || company.company_name, steps);
        if (caBatchIsWafBlock(search.status, search.text) || caBatchIsChallenge(search.text)) {
          lastError = search.status === 429 || errorCodeOf(search.text) === 15 ? 'waf_429' : 'rechallenge_search';
          item.status = 'blocked';
          item.error = lastError;
          await reclear();
          continue;
        }
        let payload = caBatchParseJson(search.text);
        if (payload && caBatchIsWafBlock(200, JSON.stringify(payload))) {
          lastError = 'waf_429';
          item.status = 'blocked';
          item.error = lastError;
          await reclear();
          continue;
        }
        let rows = caBatchRowsFromPayload(payload);
        if (!rows.length) {
          const fromDom = await readSearchDom();
          dbg(steps, 'search_dom', {
            status: search.status || 0,
            bytes: (fromDom.html || '').length,
            error: fromDom.entities && fromDom.entities.length ? undefined : 'empty_dom',
          });
          if (caBatchIsChallenge(fromDom.html)) {
            lastError = 'rechallenge_search';
            item.status = 'blocked';
            item.error = lastError;
            await reclear();
            continue;
          }
          if (fromDom.payload) rows = caBatchRowsFromPayload(fromDom.payload);
          if (!rows.length && fromDom.entities && fromDom.entities.length) {
            rows = fromDom.entities
              .filter(function (e: { EntityID?: string }) {
                return Boolean(e && e.EntityID);
              })
              .map(function (e: { EntityID?: string; EntityName?: string; EntityCity?: string }) {
                return { EntityID: e.EntityID, EntityName: e.EntityName, EntityCity: e.EntityCity };
              });
          }
        }
        if (!search.status && !rows.length) {
          lastError = 'search_no_response';
          item.status = 'error';
          item.error = lastError;
          await reclear();
          continue;
        }
        const picked = caBatchPickEntity(company.company_name, company.city || '', rows);
        if (!picked || !picked.entity || !picked.entity.EntityID) {
          item = {
            company_name: company.company_name,
            city: company.city || '',
            state: 'CA',
            status: 'not_found',
            retries: attempt,
            debug_steps: steps,
          };
          break;
        }
        const entityId = String(picked.entity.EntityID);
        const sourceUrl = caBatchSourceUrl(entityId);
        const hist = await historyViaUi(entityId, String(picked.entity.EntityName || ''), steps);
        if (caBatchIsWafBlock(hist.status, hist.text) || caBatchIsChallenge(hist.text)) {
          lastError = hist.status === 429 || errorCodeOf(hist.text) === 15 ? 'waf_429' : 'rechallenge_history';
          item.status = 'blocked';
          item.error = lastError;
          await reclear();
          continue;
        }
        const documentId = caBatchLatestSiDocumentId(caBatchParseJson(hist.text)) || '';
        let officersText = '';
        let bytesBase64 = '';
        let contentType = '';
        if (documentId) {
          const img = await siViaUi(steps);
          if (caBatchIsWafBlock(img.status, img.latin1 || img.text) || caBatchIsChallenge(img.latin1 || img.text)) {
            lastError = img.status === 429 || errorCodeOf(img.latin1 || img.text) === 15 ? 'waf_429' : 'rechallenge_pdf';
            item.status = 'blocked';
            item.error = lastError;
            await reclear();
            continue;
          }
          contentType = img.contentType;
          officersText = caBatchExtractPdfText(img.latin1);
          if (!officersText && img.latin1 && !caBatchIsChallenge(img.latin1) && !caBatchIsWafBlock(img.status, img.latin1)) {
            officersText = img.latin1;
          }
          if (caBatchTextNeedsOcr(officersText) && img.latin1) {
            bytesBase64 = Buffer.from(img.latin1, 'latin1').toString('base64').slice(0, 2000000);
          }
        }
        item = {
          company_name: company.company_name,
          city: company.city || '',
          state: 'CA',
          status: 'ok',
          retries: attempt,
          entity_id: entityId,
          business_name: picked.entity.EntityName || '',
          match_method: picked.method,
          match_score: picked.score,
          city_match: Boolean(picked.city_match),
          source_url: sourceUrl,
          document_id: documentId,
          officers_text: officersText,
          bytesBase64,
          contentType,
          agent_name: picked.entity.AgentName || '',
          debug_steps: steps,
        };
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        item.status = 'error';
        item.error = lastError;
        dbg(steps, 'exception', { status: 0, error: lastError });
      }
    }
    if (item.status !== 'ok' && item.status !== 'not_found' && lastError && !item.error) {
      item.error = lastError;
    }
    if (!item.debug_steps) item.debug_steps = steps;
    await context.pushData(item);
    processed += 1;
  }
  return { processed, blocked: false };
}

const PAGE_FUNCTION_HELPERS = [
  caBatchIsChallenge,
  caBatchIsWafBlock,
  caBatchNormalizeName,
  caBatchCoreSearchName,
  caBatchTrigram,
  caBatchPickString,
  caBatchAsRecord,
  caBatchNestedCity,
  caBatchNestedAgent,
  caBatchMapRow,
  caBatchRowsFromPayload,
  caBatchEntityCity,
  caBatchSplitDba,
  caBatchPickEntity,
  caBatchParseJson,
  caBatchLatestSiDocumentId,
  caBatchUnescapePdf,
  caBatchExtractPdfText,
  caBatchTextNeedsOcr,
  caBatchSourceUrl,
];

/** Single-function source. Apify evals `(pageFunction)` — no top-level const. */
export function caBatchPageFunctionSource(): string {
  const helpers = PAGE_FUNCTION_HELPERS.map((fn) => fn.toString()).join('\n\n');
  const constants = [
    // tsx injects __name(fn, "name") into Function#toString(); Apify has no __name.
    `function __name(fn){ return fn; }`,
    `const CA_BATCH_SEARCH_PATH = ${JSON.stringify(CA_BATCH_SEARCH_PATH)};`,
    `const CA_BATCH_HISTORY_PATH = ${JSON.stringify(CA_BATCH_HISTORY_PATH)};`,
    `const CA_BATCH_IMAGE_PATH = ${JSON.stringify(CA_BATCH_IMAGE_PATH)};`,
    `const CA_BATCH_UI = ${JSON.stringify(CA_BATCH_UI)};`,
    `const CA_BATCH_MIN_TRIGRAM = ${JSON.stringify(CA_BATCH_MIN_TRIGRAM)};`,
    `const CA_BATCH_OCR_MIN_CHARS = ${JSON.stringify(CA_BATCH_OCR_MIN_CHARS)};`,
    `const CA_BATCH_ITEM_RETRIES = ${JSON.stringify(CA_BATCH_ITEM_RETRIES)};`,
  ].join('\n');
  const src = pageFunction.toString();
  const open = src.indexOf('{');
  return `${src.slice(0, open + 1)}\n${constants}\n\n${helpers}\n${src.slice(open + 1)}`;
}
