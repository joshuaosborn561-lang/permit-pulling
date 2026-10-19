import {
  APIFY_WEB_FETCH_ACTOR_ID,
  DZ_OMAR_BIZFILE_ACTOR_ID,
  runApifyActorRaw,
} from './apifyPlaywright.js';
import {
  caBatchLatestSiDocumentId,
  caBatchMapRow,
  caBatchPickEntity,
  caBatchSourceUrl,
  type CaBatchCompany,
  type CaBatchDatasetItem,
  type CaBatchEntity,
} from './caBatchLogic.js';
import { companySearchQueries } from '../names.js';
import type { LookupContext } from './context.js';
import { CA_HYBRID_MAX_RESULTS_DEFAULT, estimateCaHybridUsd } from './spend.js';

export function caHybridMaxResults(ctx?: LookupContext): number {
  const fromCtx = Number(ctx?.caHybridMaxResultsPerQuery);
  if (Number.isFinite(fromCtx) && fromCtx > 0) return Math.min(50, Math.floor(fromCtx));
  const fromEnv = Number(process.env.CA_HYBRID_MAX_RESULTS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.min(50, Math.floor(fromEnv));
  return CA_HYBRID_MAX_RESULTS_DEFAULT;
}

export function caBatchShouldHybrid(item: CaBatchDatasetItem | undefined): boolean {
  if (!item) return true;
  if (item.entity_id && item.status === 'ok') return false;
  if (item.status === 'not_found') return false;
  const blob = `${item.error || ''} ${JSON.stringify(item.debug_steps || [])}`;
  if (
    /search_input_missing|block_page_before_search|incapsula|waf_429|empty_dom|actor_failed|search_no_response|handler timeout|timed.?out/i.test(
      blob,
    )
  ) {
    return true;
  }
  return item.status === 'blocked' || item.status === 'error';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function queryOf(row: Record<string, unknown>): string {
  return String(row.searchQuery || row.search_query || row.query || row.searchTerm || row.SEARCH_VALUE || '').trim();
}

function entityFromHybridRow(row: Record<string, unknown>): CaBatchEntity | null {
  const mapped = caBatchMapRow(row);
  if (mapped?.EntityID || mapped?.EntityName) return mapped;
  const name = String(row.entityName || row.entity_name || row.name || row.TITLE || '').trim();
  const id = String(
    row.entityNumber || row.entity_number || row.entityId || row.EntityID || row.number || '',
  ).trim();
  if (!name && !id) return null;
  return {
    EntityID: id || undefined,
    EntityName: name || undefined,
    EntityCity: String(row.city || row.EntityCity || row.principalCity || '').trim() || null,
    AgentName: String(row.agentName || row.agent || row.registeredAgent || '').trim() || null,
  };
}

function flattenHybridItems(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const nested = item.results || item.records || item.entities || item.data;
    if (Array.isArray(nested) && nested.length) {
      for (const row of nested) {
        const rec = asRecord(row);
        if (!rec) continue;
        if (!queryOf(rec) && queryOf(item)) rec.searchQuery = queryOf(item);
        out.push(rec);
      }
    } else {
      out.push(item);
    }
  }
  return out;
}

function siUrlFromRow(row: Record<string, unknown>): { url: string; documentId: string } {
  const id = caBatchLatestSiDocumentId(row);
  if (id) {
    return { url: `https://bizfileonline.sos.ca.gov/api/report/GetImageByNum/${id}`, documentId: id };
  }
  const urls: string[] = [];
  const walk = (node: unknown): void => {
    if (!node) return;
    if (typeof node === 'string') {
      if (/GetImageByNum\/[0-9]+/i.test(node) || /\.pdf($|\?)/i.test(node) || /^https?:\/\//i.test(node)) {
        urls.push(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = asRecord(node);
    if (!rec) return;
    const filing = String(rec.filingType || rec.FILING_TYPE || rec.type || rec.title || rec.name || '');
    const href = String(rec.documentUrl || rec.document_url || rec.url || rec.href || rec.pdfUrl || rec.fileUrl || '');
    if (href && /statement of information|SI-550|LLC-12|GetImageByNum|\.pdf/i.test(`${filing} ${href}`)) {
      urls.unshift(href);
    } else if (href) {
      urls.push(href);
    }
    for (const value of Object.values(rec)) walk(value);
  };
  walk(row);
  const hit = urls.find((u) => /GetImageByNum|statement of information|\.pdf/i.test(u)) || '';
  const m = hit.match(/GetImageByNum\/([0-9]+)/i);
  return { url: hit, documentId: m ? m[1] : '' };
}

export interface CaHybridRunResult {
  items: CaBatchDatasetItem[];
  usd: number;
  cu: number;
  proxyGb: number;
  runs: number;
  refused: boolean;
  perCompanyUsd: number;
}

export async function runCaHybrid(
  companies: CaBatchCompany[],
  ctx?: LookupContext,
): Promise<CaHybridRunResult> {
  const empty: CaHybridRunResult = {
    items: [],
    usd: 0,
    cu: 0,
    proxyGb: 0,
    runs: 0,
    refused: false,
    perCompanyUsd: 0,
  };
  if (!companies.length) return empty;

  const maxResults = caHybridMaxResults(ctx);
  const planned = companies.map((company) => ({
    company,
    queries: companySearchQueries(company.company_name),
  }));

  const searchHybrid = async (queries: string[]) => {
    const unique = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
    if (!unique.length) {
      return { succeeded: false, refused: false, items: [] as Array<Record<string, unknown>>, usd: 0, cu: 0, proxyGb: 0 };
    }
    return runApifyActorRaw(ctx, {
      actorId: DZ_OMAR_BIZFILE_ACTOR_ID,
      input: {
        registers: ['business'],
        searchQueries: unique.map((q) => q.slice(0, 49)),
        matchType: '0',
        searchType: '1',
        detailLevel: 'history',
        maxResultsPerQuery: maxResults,
        proxyConfiguration: {
          useApifyProxy: true,
          apifyProxyGroups: ['RESIDENTIAL'],
          apifyProxyCountry: 'US',
        },
      },
      estimateUsd: estimateCaHybridUsd(unique.length, maxResults),
      lookups: unique.length,
      pollMaxMs: 20 * 60 * 1000,
    });
  };

  const search = await searchHybrid(planned.map((row) => row.queries[0] || row.company.company_name));
  empty.runs += 1;
  empty.usd += search.usd;
  empty.cu += search.cu;
  empty.proxyGb += search.proxyGb;

  if (search.refused && !search.items.length) {
    empty.refused = true;
    for (const company of companies) {
      empty.items.push({
        company_name: company.company_name,
        city: company.city || '',
        state: 'CA',
        status: 'blocked',
        retries: 0,
        error: 'hybrid_search_refused',
        debug_steps: [{ step: 'hybrid_search', status: 0, error: 'hybrid_search_refused' }],
      });
    }
    return empty;
  }

  const flat = flattenHybridItems(search.items.filter((row) => row && typeof row === 'object') as Array<Record<string, unknown>>);
  const byQuery = new Map<string, Array<Record<string, unknown>>>();
  for (const row of flat) {
    const q = queryOf(row).toUpperCase();
    const list = byQuery.get(q) || [];
    list.push(row);
    byQuery.set(q, list);
  }

  const pickForCompany = (company: CaBatchCompany, queries: string[]) => {
    const keys = queries.map((q) => q.trim().toUpperCase()).filter(Boolean);
    const pool: Array<Record<string, unknown>> = [];
    const seenRows = new Set<string>();
    for (const key of keys) {
      for (const row of byQuery.get(key) || []) {
        const id = String(row.entityNumber || row.entity_number || row.EntityID || JSON.stringify(row));
        if (seenRows.has(id)) continue;
        seenRows.add(id);
        pool.push(row);
      }
    }
    const entities: CaBatchEntity[] = [];
    const seen = new Set<string>();
    for (const row of pool) {
      const ent = entityFromHybridRow(row);
      if (!ent || !ent.EntityID) continue;
      const id = String(ent.EntityID);
      if (seen.has(id)) continue;
      seen.add(id);
      entities.push(ent);
    }
    return { pool, picked: caBatchPickEntity(company.company_name, company.city || '', entities) };
  };

  const misses: typeof planned = [];
  for (const row of planned) {
    const { picked } = pickForCompany(row.company, row.queries.slice(0, 1));
    if (!picked?.entity?.EntityID && row.queries[1]) misses.push(row);
  }
  if (misses.length) {
    const retry = await searchHybrid(misses.map((row) => row.queries[1]));
    empty.runs += 1;
    empty.usd += retry.usd;
    empty.cu += retry.cu;
    empty.proxyGb += retry.proxyGb;
    const extra = flattenHybridItems(retry.items.filter((row) => row && typeof row === 'object') as Array<Record<string, unknown>>);
    for (const item of extra) {
      const q = queryOf(item).toUpperCase();
      const list = byQuery.get(q) || [];
      list.push(item);
      byQuery.set(q, list);
      flat.push(item);
    }
  }

  for (const company of companies) {
    const queries = planned.find((row) => row.company === company)?.queries || companySearchQueries(company.company_name);
    const steps: NonNullable<CaBatchDatasetItem['debug_steps']> = [
      { step: 'hybrid_search', status: search.succeeded ? 200 : 0, bytes: search.items.length },
    ];
    const { pool, picked } = pickForCompany(company, queries);
    if (!picked?.entity?.EntityID) {
      empty.items.push({
        company_name: company.company_name,
        city: company.city || '',
        state: 'CA',
        status: search.succeeded ? 'not_found' : 'blocked',
        retries: 0,
        error: search.succeeded ? undefined : 'hybrid_search_failed',
        debug_steps: steps,
      });
      continue;
    }
    const matchRow =
      pool.find((row) => {
        const ent = entityFromHybridRow(row);
        return ent && String(ent.EntityID) === String(picked.entity.EntityID);
      }) || {};
    const si = siUrlFromRow(matchRow);
    let officersText = '';
    let bytesBase64 = '';
    let contentType = '';
    if (si.url) {
      const pdf = await runApifyActorRaw(ctx, {
        actorId: APIFY_WEB_FETCH_ACTOR_ID,
        input: { url: si.url, formats: ['text', 'markdown', 'raw'] },
        estimateUsd: 0.01,
        lookups: 1,
        pollMaxMs: 4 * 60 * 1000,
      });
      empty.runs += 1;
      empty.usd += pdf.usd;
      empty.cu += pdf.cu;
      empty.proxyGb += pdf.proxyGb;
      const rec = pdf.items[0] || {};
      officersText = String(rec.text || rec.markdown || rec.officers_text || '');
      if (typeof rec.raw === 'string' && rec.raw.length > 80) {
        bytesBase64 = rec.raw.slice(0, 2_000_000);
        contentType = String(rec.contentType || rec.content_type || 'application/pdf');
      }
      steps.push({
        step: 'hybrid_si',
        status: pdf.succeeded ? 200 : 0,
        bytes: officersText.length,
        error: pdf.succeeded ? undefined : 'web_fetch_failed',
      });
    }
    empty.items.push({
      company_name: company.company_name,
      city: company.city || '',
      state: 'CA',
      status: 'ok',
      retries: 0,
      entity_id: String(picked.entity.EntityID),
      business_name: picked.entity.EntityName || '',
      match_method: picked.method,
      match_score: picked.score,
      city_match: picked.city_match,
      source_url: caBatchSourceUrl(picked.entity.EntityID),
      document_id: si.documentId || undefined,
      officers_text: officersText || undefined,
      bytesBase64: bytesBase64 || undefined,
      contentType: contentType || undefined,
      agent_name: picked.entity.AgentName || undefined,
      debug_steps: steps,
    });
  }

  empty.usd = Number(empty.usd.toFixed(4));
  empty.proxyGb = Number(empty.proxyGb.toFixed(6));
  empty.perCompanyUsd = companies.length ? Number((empty.usd / companies.length).toFixed(4)) : 0;
  return empty;
}
