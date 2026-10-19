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
  caBatchLatestSiDocumentId,
  caBatchMapRow,
  caBatchNestedAgent,
  caBatchNestedCity,
  caBatchNormalizeName,
  caBatchParseJson,
  caBatchPickEntity,
  caBatchPickString,
  caBatchRowsFromPayload,
  caBatchSearchBody,
  caBatchSourceUrl,
  caBatchSplitDba,
  caBatchTextNeedsOcr,
  caBatchTrigram,
  caBatchUnescapePdf,
} from './caBatchLogic.js';
import { CA_BATCH_ITEM_RETRIES } from './spend.js';

/**
 * Apify playwright-scraper pageFunction: clear Incapsula once, then search /
 * match / history / SI PDF for every company in request.userData.companies.
 * Re-clears and retries a company on mid-session challenge (capped).
 */
async function pageFunction(context: {
  page: {
    content: () => Promise<string>;
    waitForTimeout: (ms: number) => Promise<void>;
    reload: (opts: { waitUntil: string }) => Promise<unknown>;
    goto: (url: string, opts: { waitUntil: string }) => Promise<unknown>;
    evaluate: (fn: (...args: never[]) => unknown, arg?: unknown) => Promise<unknown>;
  };
  request: { userData?: { companies?: Array<{ company_name: string; city?: string | null }> } };
  pushData: (item: unknown) => Promise<void>;
}): Promise<{ processed: number; blocked: boolean }> {
  const page = context.page;
  const companies = (context.request.userData && context.request.userData.companies) || [];
  const retriesCap = CA_BATCH_ITEM_RETRIES;

  async function waitClear(): Promise<boolean> {
    for (let i = 0; i < 40; i++) {
      const html = await page.content();
      if (!caBatchIsChallenge(html)) return true;
      await page.waitForTimeout(1500);
      if (i % 8 === 7) {
        try {
          await page.reload({ waitUntil: 'domcontentloaded' });
        } catch {
          /* keep waiting */
        }
      }
    }
    const last = await page.content();
    return !caBatchIsChallenge(last);
  }

  async function reclear(): Promise<boolean> {
    try {
      await page.goto(CA_BATCH_UI, { waitUntil: 'domcontentloaded' });
    } catch {
      /* still try waitClear */
    }
    return waitClear();
  }

  async function fetchText(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; text: string; contentType: string }> {
    return (await page.evaluate(
      async (payload: { url: string; init: typeof init }) => {
        const res = await fetch(payload.url, {
          credentials: 'include',
          method: payload.init?.method,
          headers: payload.init?.headers,
          body: payload.init?.body,
        });
        return {
          status: res.status,
          text: await res.text(),
          contentType: res.headers.get('content-type') || '',
        };
      },
      { url, init: init || null },
    )) as { status: number; text: string; contentType: string };
  }

  async function fetchLatin1(url: string): Promise<{ status: number; latin1: string; contentType: string }> {
    return (await page.evaluate(async (href: string) => {
      const res = await fetch(href, { credentials: 'include' });
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
      }
      return {
        status: res.status,
        latin1: binary,
        contentType: res.headers.get('content-type') || '',
      };
    }, url)) as { status: number; latin1: string; contentType: string };
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
      });
    }
    return { processed: 0, blocked: true };
  }

  let processed = 0;
  for (const company of companies) {
    let lastError = '';
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
        const body = caBatchSearchBody(company.company_name);
        const search = await fetchText(CA_BATCH_SEARCH_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
        if (caBatchIsChallenge(search.text) || search.status === 403 || search.status === 401) {
          lastError = 'rechallenge_search';
          item.status = 'blocked';
          const ok = await reclear();
          if (!ok) continue;
          continue;
        }
        const payload = caBatchParseJson(search.text);
        const picked = caBatchPickEntity(company.company_name, company.city || '', caBatchRowsFromPayload(payload));
        if (!picked || !picked.entity || !picked.entity.EntityID) {
          item = {
            company_name: company.company_name,
            city: company.city || '',
            state: 'CA',
            status: 'not_found',
            retries: attempt,
          };
          break;
        }
        const entityId = String(picked.entity.EntityID);
        const sourceUrl = caBatchSourceUrl(entityId);
        const hist = await fetchText(CA_BATCH_HISTORY_PATH + encodeURIComponent(entityId));
        if (caBatchIsChallenge(hist.text) || hist.status === 403 || hist.status === 401) {
          lastError = 'rechallenge_history';
          item.status = 'blocked';
          await reclear();
          continue;
        }
        const documentId = caBatchLatestSiDocumentId(caBatchParseJson(hist.text)) || '';
        let officersText = '';
        let bytesBase64 = '';
        let contentType = '';
        if (documentId) {
          const img = await fetchLatin1(CA_BATCH_IMAGE_PATH + encodeURIComponent(documentId));
          if (caBatchIsChallenge(img.latin1) || img.status === 403 || img.status === 401) {
            lastError = 'rechallenge_pdf';
            item.status = 'blocked';
            await reclear();
            continue;
          }
          contentType = img.contentType;
          officersText = caBatchExtractPdfText(img.latin1);
          if (!officersText && img.latin1 && !caBatchIsChallenge(img.latin1)) {
            officersText = img.latin1;
          }
          if (caBatchTextNeedsOcr(officersText) && img.latin1) {
            const cap = img.latin1.slice(0, 1500000);
            bytesBase64 = (await page.evaluate((latin1: string) => btoa(latin1), cap)) as string;
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
          source_url: sourceUrl,
          document_id: documentId,
          officers_text: officersText,
          bytesBase64,
          contentType,
          agent_name: picked.entity.AgentName || '',
        };
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        item.status = 'error';
        item.error = lastError;
      }
    }
    if (item.status !== 'ok' && item.status !== 'not_found' && lastError && !item.error) {
      item.error = lastError;
    }
    await context.pushData(item);
    processed += 1;
  }
  return { processed, blocked: false };
}

const PAGE_FUNCTION_HELPERS = [
  caBatchIsChallenge,
  caBatchNormalizeName,
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
  caBatchSearchBody,
  caBatchParseJson,
  caBatchLatestSiDocumentId,
  caBatchUnescapePdf,
  caBatchExtractPdfText,
  caBatchTextNeedsOcr,
  caBatchSourceUrl,
];

export function caBatchPageFunctionSource(): string {
  const helpers = PAGE_FUNCTION_HELPERS.map((fn) => fn.toString()).join('\n\n');
  const constants = [
    `const CA_BATCH_SEARCH_PATH = ${JSON.stringify(CA_BATCH_SEARCH_PATH)};`,
    `const CA_BATCH_HISTORY_PATH = ${JSON.stringify(CA_BATCH_HISTORY_PATH)};`,
    `const CA_BATCH_IMAGE_PATH = ${JSON.stringify(CA_BATCH_IMAGE_PATH)};`,
    `const CA_BATCH_UI = ${JSON.stringify(CA_BATCH_UI)};`,
    `const CA_BATCH_MIN_TRIGRAM = ${JSON.stringify(CA_BATCH_MIN_TRIGRAM)};`,
    `const CA_BATCH_OCR_MIN_CHARS = ${JSON.stringify(CA_BATCH_OCR_MIN_CHARS)};`,
    `const CA_BATCH_ITEM_RETRIES = ${JSON.stringify(CA_BATCH_ITEM_RETRIES)};`,
  ].join('\n');
  return `${constants}\n\n${helpers}\n\n${pageFunction.toString()}`;
}
