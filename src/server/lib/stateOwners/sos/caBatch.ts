import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isChallengePage } from '../http.js';
import { CA_BATCH_POLL_MAX_MS, runPlaywrightActor } from './apifyPlaywright.js';
import { caBatchPageFunctionSource } from './caBatchPageFunction.js';
import { caBatchShouldHybrid, runCaHybrid } from './caHybrid.js';
import {
  CA_BATCH_UI,
  caBatchCompanyKey,
  caBatchIsChallenge,
  caBatchIsWafBlock,
  type CaBatchCompany,
  type CaBatchDatasetItem,
} from './caBatchLogic.js';
import { parseSiOfficerTable } from './caSi.js';
import type { LookupContext } from './context.js';
import { ctxSpend } from './context.js';
import { textFromDocument } from './ocr.js';
import { hitsFromRoster } from './officers.js';
import {
  CA_BATCH_COMPANIES_PER_RUN,
  CA_BATCH_ITEM_RETRIES,
  estimateCaBatchUsd,
  estimateCaHybridUsd,
} from './spend.js';
import type { CoverageReason } from '../types.js';
import type { NameLookupInput, NameLookupResult } from './types.js';
import { agentOnlyHit } from './waterfall.js';

function emptyCaResult(
  input: NameLookupInput,
  coverage: CoverageReason,
  extra?: Partial<NameLookupResult>,
): NameLookupResult {
  return {
    people: [],
    coverage_reason: coverage,
    source: 'ca_bizfile',
    implemented: true,
    source_url: CA_BATCH_UI,
    ...extra,
  };
}

export type { CaBatchCompany, CaBatchDatasetItem } from './caBatchLogic.js';

export interface CaBatchCheckpoint {
  version: 1;
  job_id: string;
  updated_at: string;
  items: Record<string, CaBatchDatasetItem>;
}

export interface CaBatchRunResult {
  results: NameLookupResult[];
  checkpoint: CaBatchCheckpoint;
  refused: boolean;
  usd: number;
  cu: number;
  proxyGb: number;
  runs: number;
  hybridUsed?: boolean;
  perCompanyUsd?: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function defaultCaBatchCheckpointPath(jobId: string): string {
  const fromEnv = process.env.CA_BATCH_CHECKPOINT?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(tmpdir(), `permits-ca-batch-${jobId || 'default'}.json`);
}

export function loadCaBatchCheckpoint(path: string, jobId: string): CaBatchCheckpoint {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as CaBatchCheckpoint;
    if (raw && raw.version === 1 && raw.items && typeof raw.items === 'object') {
      return { version: 1, job_id: raw.job_id || jobId, updated_at: raw.updated_at || '', items: raw.items };
    }
  } catch {
    /* missing or corrupt → start empty */
  }
  return { version: 1, job_id: jobId, updated_at: new Date().toISOString(), items: {} };
}

export function saveCaBatchCheckpoint(path: string, checkpoint: CaBatchCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  checkpoint.updated_at = new Date().toISOString();
  writeFileSync(path, JSON.stringify(checkpoint, null, 2) + '\n', 'utf8');
}

export function caBatchItemComplete(item: CaBatchDatasetItem | undefined): boolean {
  if (!item) return false;
  if (item.status === 'ok' || item.status === 'not_found') return true;
  return (item.retries || 0) >= CA_BATCH_ITEM_RETRIES;
}

function asDatasetItem(raw: unknown, fallback: CaBatchCompany): CaBatchDatasetItem {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const statusRaw = String(row.status || 'error');
  let status: CaBatchDatasetItem['status'] =
    statusRaw === 'ok' || statusRaw === 'not_found' || statusRaw === 'blocked' || statusRaw === 'error'
      ? statusRaw
      : 'error';
  const lastSearch = Array.isArray(row.debug_steps)
    ? [...(row.debug_steps as Array<{ step?: string; status?: number }>)].reverse().find((s) => s && s.step === 'search')
    : undefined;
  if (
    status === 'not_found' &&
    (caBatchIsWafBlock(0, String(row.error || '')) ||
      caBatchIsWafBlock(Number(lastSearch?.status) || 0, JSON.stringify(lastSearch || {})))
  ) {
    status = 'blocked';
  }
  const methodRaw = String(row.match_method || '');
  const match_method: CaBatchDatasetItem['match_method'] =
    methodRaw === 'exact' || methodRaw === 'substring' || methodRaw === 'trigram' ? methodRaw : undefined;
  return {
    company_name: String(row.company_name || fallback.company_name || ''),
    city: String(row.city || fallback.city || ''),
    state: 'CA',
    status,
    retries: Number(row.retries) || 0,
    entity_id: row.entity_id ? String(row.entity_id) : undefined,
    business_name: row.business_name ? String(row.business_name) : undefined,
    match_method,
    match_score: typeof row.match_score === 'number' ? row.match_score : undefined,
    source_url: row.source_url ? String(row.source_url) : undefined,
    document_id: row.document_id ? String(row.document_id) : undefined,
    officers_text: row.officers_text ? String(row.officers_text) : undefined,
    bytesBase64: row.bytesBase64 ? String(row.bytesBase64) : undefined,
    contentType: row.contentType ? String(row.contentType) : undefined,
    agent_name: row.agent_name ? String(row.agent_name) : undefined,
    error: row.error ? String(row.error) : undefined,
    debug_steps: Array.isArray(row.debug_steps)
      ? (row.debug_steps as CaBatchDatasetItem['debug_steps'])
      : undefined,
  };
}

export async function mapCaBatchItemToResult(
  input: NameLookupInput,
  item: CaBatchDatasetItem | undefined,
  ctx?: LookupContext,
): Promise<NameLookupResult> {
  if (!item) {
    return emptyCaResult(input, 'not_found');
  }
  const lastSearch = [...(item.debug_steps || [])].reverse().find((s) => s && s.step === 'search');
  if (
    item.status === 'blocked' ||
    (!item.entity_id &&
      (caBatchIsWafBlock(0, item.error || '') ||
        caBatchIsWafBlock(Number(lastSearch?.status) || 0, JSON.stringify(lastSearch || {}))))
  ) {
    return emptyCaResult(input, 'blocked', {
      source_url: item.source_url || CA_BATCH_UI,
      via_apify: true,
    });
  }
  const entityId = String(item.entity_id || '').trim();
  if (item.status === 'not_found' || !entityId) {
    return emptyCaResult(input, 'not_found', {
      source_url: item.source_url || CA_BATCH_UI,
      via_apify: true,
      match_method: item.match_method,
      match_score: item.match_score,
    });
  }

  let officersText = item.officers_text || '';
  let ocrUsed = false;
  if (caBatchIsChallenge(officersText) || isChallengePage(officersText)) officersText = '';
  if ((!officersText || officersText.replace(/[^A-Za-z]/g, '').length < 40) && item.bytesBase64) {
    try {
      const bytes = Buffer.from(item.bytesBase64, 'base64');
      const doc = await textFromDocument(bytes, item.contentType || 'application/pdf', ctx);
      if (doc.text && !isChallengePage(doc.text) && !caBatchIsChallenge(doc.text)) {
        officersText = doc.text;
        ocrUsed = doc.ocr_used;
      }
    } catch {
      /* keep extracted text */
    }
  }

  const entries = parseSiOfficerTable(officersText);
  const sourceUrl = item.source_url || `${CA_BATCH_UI}/${encodeURIComponent(entityId)}`;
  const officers = hitsFromRoster(input, entries, 'ca_bizfile', sourceUrl, item.match_method);
  if (officers.length) {
    return {
      people: officers,
      coverage_reason: null,
      source: 'ca_bizfile',
      source_url: sourceUrl,
      match_method: item.match_method,
      match_score: item.match_score,
      entity_id: entityId,
      business_name: item.business_name || null,
      implemented: true,
      via_apify: true,
      ocr_used: ocrUsed,
    };
  }
  const agent =
    ctx?.includeAgents === true ? agentOnlyHit(input, item.agent_name || '', 'ca_bizfile', sourceUrl) : null;
  return {
    people: agent ? [agent] : [],
    coverage_reason: 'agent_only',
    source: 'ca_bizfile',
    source_url: sourceUrl,
    match_method: item.match_method,
    match_score: item.match_score,
    entity_id: entityId,
    business_name: item.business_name || null,
    implemented: true,
    via_apify: true,
    ocr_used: ocrUsed,
  };
}

export async function runCaBatch(
  inputs: NameLookupInput[],
  ctx?: LookupContext,
  opts?: { jobId?: string; checkpointPath?: string },
): Promise<CaBatchRunResult> {
  const jobId = opts?.jobId || 'ca-batch';
  const checkpointPath = opts?.checkpointPath || ctx?.caBatchCheckpointPath || defaultCaBatchCheckpointPath(jobId);
  const checkpoint = loadCaBatchCheckpoint(checkpointPath, jobId);
  const spend = ctxSpend(ctx);
  const empty: CaBatchRunResult = {
    results: [],
    checkpoint,
    refused: false,
    usd: 0,
    cu: 0,
    proxyGb: 0,
    runs: 0,
  };

  const companies: CaBatchCompany[] = inputs.map((row) => ({
    company_name: row.company_name,
    city: row.city || '',
    state: 'CA',
  }));

  if (ctx?.caBatchItems?.length) {
    for (const raw of ctx.caBatchItems) {
      const key = caBatchCompanyKey(raw.company_name, raw.city);
      checkpoint.items[key] = raw;
    }
    saveCaBatchCheckpoint(checkpointPath, checkpoint);
  } else if (ctx?.live !== false && ctx?.apifyEnabled !== false) {
    const remaining = companies.filter((c) => !caBatchItemComplete(checkpoint.items[caBatchCompanyKey(c.company_name, c.city)]));
    if (!remaining.length && companies.length) {
      /* resume: everything already checkpointed */
    } else {
      const estimate = estimateCaBatchUsd(remaining.length || companies.length);
      if (spend.wouldExceed(estimate)) {
        spend.refuse();
        empty.refused = true;
        empty.results = await Promise.all(inputs.map((row) => mapCaBatchItemToResult(row, checkpoint.items[caBatchCompanyKey(row.company_name, row.city)], ctx)));
        return empty;
      }
      const pageFunction = caBatchPageFunctionSource();
      for (const group of chunk(remaining, CA_BATCH_COMPANIES_PER_RUN)) {
        const groupEstimate = estimateCaBatchUsd(group.length);
        if (spend.wouldExceed(groupEstimate)) {
          spend.refuse();
          empty.refused = true;
          break;
        }
        const run = await runPlaywrightActor(ctx, {
          startUrls: [
            {
              url: CA_BATCH_UI,
              userData: { companies: group, debug: Boolean(ctx?.caBatchDebug) },
            },
          ],
          pageFunction,
          pollMaxMs: CA_BATCH_POLL_MAX_MS,
          maxConcurrency: 1,
          proxyRotation: 'UNTIL_FAILURE',
          maxRequestsPerCrawl: 1,
          estimateUsd: groupEstimate,
          lookups: group.length,
        });
        empty.runs += 1;
        empty.usd = Number((empty.usd + run.usd).toFixed(4));
        empty.cu += run.cu;
        empty.proxyGb = Number((empty.proxyGb + run.proxyGb).toFixed(6));
        if (run.refused && !run.items.length) {
          empty.refused = true;
          break;
        }
        const byKey = new Map<string, CaBatchDatasetItem>();
        for (const raw of run.items) {
          const item = asDatasetItem(raw, { company_name: '', city: '' });
          if (!item.company_name) continue;
          byKey.set(caBatchCompanyKey(item.company_name, item.city), item);
        }
        for (const company of group) {
          const key = caBatchCompanyKey(company.company_name, company.city);
          const prev = checkpoint.items[key];
          const next = byKey.get(key) || asDatasetItem(
            {
              company_name: company.company_name,
              city: company.city || '',
              state: 'CA',
              status: run.succeeded ? 'error' : 'blocked',
              retries: (prev?.retries || 0) + 1,
              error: run.succeeded ? 'missing_dataset_item' : 'actor_failed',
            },
            company,
          );
          if (prev && next.retries < prev.retries) next.retries = prev.retries;
          checkpoint.items[key] = next;
        }
        saveCaBatchCheckpoint(checkpointPath, checkpoint);
        if (run.refused) {
          empty.refused = true;
        }
        const hybridNeed = group.filter((company) =>
          caBatchShouldHybrid(checkpoint.items[caBatchCompanyKey(company.company_name, company.city)]),
        );
        if (hybridNeed.length) {
          const hybridEst = estimateCaHybridUsd(hybridNeed.length);
          if (spend.wouldExceed(hybridEst)) {
            spend.refuse();
            empty.refused = true;
          } else {
            const hybrid = await runCaHybrid(hybridNeed, ctx);
            empty.runs += hybrid.runs;
            empty.usd = Number((empty.usd + hybrid.usd).toFixed(4));
            empty.cu += hybrid.cu;
            empty.proxyGb = Number((empty.proxyGb + hybrid.proxyGb).toFixed(6));
            empty.hybridUsed = true;
            empty.perCompanyUsd = hybrid.perCompanyUsd;
            for (const item of hybrid.items) {
              const key = caBatchCompanyKey(item.company_name, item.city);
              checkpoint.items[key] = item;
            }
            saveCaBatchCheckpoint(checkpointPath, checkpoint);
            if (hybrid.refused) empty.refused = true;
          }
        }
        if (empty.refused && !hybridNeed.length) break;
      }
    }
  } else {
    for (const company of companies) {
      const key = caBatchCompanyKey(company.company_name, company.city);
      if (!checkpoint.items[key]) {
        checkpoint.items[key] = {
          company_name: company.company_name,
          city: company.city || '',
          state: 'CA',
          status: 'not_found',
          retries: 0,
        };
      }
    }
    saveCaBatchCheckpoint(checkpointPath, checkpoint);
  }

  empty.checkpoint = checkpoint;
  empty.results = await Promise.all(
    inputs.map((row) => mapCaBatchItemToResult(row, checkpoint.items[caBatchCompanyKey(row.company_name, row.city)], ctx)),
  );
  const snap = spend.snapshot();
  empty.usd = snap.apify_usd_spent || empty.usd;
  empty.cu = snap.apify_compute_units || empty.cu;
  empty.proxyGb = snap.apify_proxy_gb || empty.proxyGb;
  return empty;
}
