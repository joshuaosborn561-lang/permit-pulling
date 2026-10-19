import { normalizeState } from '../lib/stateOwners/names.js';
import {
  catalogByCode,
  catalogInRolloutOrder,
  getJob,
  newJobId,
  ownerYieldPossible,
  putJob,
  patchJob,
  resolveNameLookup,
  type BusinessOwnerJobSnapshot,
  type BusinessOwnerNamelessSample,
  type LookupContext,
  type NameLookupInput,
  type NameLookupResult,
} from '../lib/stateOwners/sos/index.js';
import { defaultLookupContext } from '../lib/stateOwners/sos/context.js';
import { mapPool } from '../lib/stateOwners/sos/pool.js';
import { runCaBatch } from '../lib/stateOwners/sos/caBatch.js';
import {
  APIFY_USD_PER_BLOCKED_LOOKUP,
  CA_APIFY_LOOKUPS_PER_ROW,
  SERPER_QUERIES_PER_ROW,
  SERPER_USD_PER_QUERY,
  estimateCaBatchUsd,
  estimateSerperCredits,
  estimateSerperUsd,
} from '../lib/stateOwners/sos/spend.js';
import { isWaterfallReady } from '../lib/stateOwners/sos/waterfall.js';

export { APIFY_USD_PER_BLOCKED_LOOKUP };
export const SOS_HTTP_LANES = 4;
/** Existing write gate. Keep well under the 60-connection project cap. */
export const OWNER_LOOKUP_WRITE_CONCURRENCY = 4;
/** Phase 2 still does not persist people. CLI and MCP are counts / local CSV only. */
export const WRITES_ENABLED = false;
/** @deprecated use WRITES_ENABLED */
export const PHASE1_WRITES_ENABLED = WRITES_ENABLED;
export const OWNER_LOOKUP_PHASE = 2;
export const MAX_BATCH_ROWS = 5000;

const FIRST_USE_ASSUMED_TOTAL = 15359;
const FIRST_USE_ASSUMED_CA_SHARE = 0.85;

export interface LookupBusinessOwnerOpts {
  source_table?: string;
  where?: string;
  list_id?: string;
  rows?: NameLookupInput[];
  states?: string[];
  max_rows?: number;
  dry_run?: boolean;
  estimate_only?: boolean;
  include_agents?: boolean;
  job_id?: string;
  wait?: boolean;
  context?: LookupContext;
  concurrency?: number;
  /** One sticky Playwright session for CA (Incapsula once, then hundreds of companies). */
  ca_batch?: boolean;
}

function emptyStateStats() {
  return { attempted: 0, named: 0, agent_only: 0, hit_rate: 0 };
}

export function estimateApifyUsd(inputs: NameLookupInput[], opts?: { ca_batch?: boolean }): number {
  const catalog = catalogByCode();
  if (opts?.ca_batch) {
    const ca = inputs.filter((row) => normalizeState(row.state) === 'CA');
    const other = inputs.filter((row) => normalizeState(row.state) !== 'CA');
    return Number((estimateCaBatchUsd(ca.length) + estimateApifyUsd(other)).toFixed(2));
  }
  let blocked = 0;
  for (const row of inputs) {
    const st = normalizeState(row.state);
    const entry = catalog.get(st);
    if (!entry) continue;
    if (entry.apify === 'fallback' && ownerYieldPossible(entry.officers)) {
      blocked += st === 'CA' ? CA_APIFY_LOOKUPS_PER_ROW : 1;
    }
  }
  return Number((blocked * APIFY_USD_PER_BLOCKED_LOOKUP).toFixed(2));
}

export function estimateRuntimeSeconds(rowCount: number, lanes = SOS_HTTP_LANES): number {
  const width = Math.max(1, lanes);
  const secondsPerRow = 2.4;
  return Math.ceil((rowCount * secondsPerRow) / width);
}

export function firstUseEnvelope(): Record<string, unknown> {
  const ca = Math.round(FIRST_USE_ASSUMED_TOTAL * FIRST_USE_ASSUMED_CA_SHARE);
  const other = FIRST_USE_ASSUMED_TOTAL - ca;
  return {
    assumed_total: FIRST_USE_ASSUMED_TOTAL,
    assumed_ca_share: FIRST_USE_ASSUMED_CA_SHARE,
    assumed_ca_rows: ca,
    assumed_other_rows: other,
    note: 'Mix is an assumption (mostly CA). Re-run estimate_only against source_table counts before a live job. No lead names.',
    supabase_pool_cap: 60,
    supabase_project: 'azpapwtnrbzywlnxxecz',
    http_lanes: SOS_HTTP_LANES,
    write_concurrency: OWNER_LOOKUP_WRITE_CONCURRENCY,
    ca_bizfile_api: 'unavailable_government_agencies_only',
    ca_direct_http_usd: 0,
    ca_apify_mid_usd: Number((ca * APIFY_USD_PER_BLOCKED_LOOKUP * CA_APIFY_LOOKUPS_PER_ROW).toFixed(2)),
    ca_apify_lookups_per_row: CA_APIFY_LOOKUPS_PER_ROW,
    other_apify_mid_if_all_blocked_usd: Number((other * APIFY_USD_PER_BLOCKED_LOOKUP).toFixed(2)),
    runtime_seconds_ca_direct: estimateRuntimeSeconds(ca),
    apify_usd_per_blocked_lookup: APIFY_USD_PER_BLOCKED_LOOKUP,
    serper_queries_per_row: SERPER_QUERIES_PER_ROW,
    serper_usd_per_query: SERPER_USD_PER_QUERY,
    serper_credits: estimateSerperCredits(FIRST_USE_ASSUMED_TOTAL),
    serper_usd: estimateSerperUsd(FIRST_USE_ASSUMED_TOTAL),
    serper_note:
      'Serper-first (google.serper.dev, SERPER_API_KEY): 5 queries/row (generic + OpenCorporates + Bizapedia + Sunbiz + state SOS). Apify Playwright is only the fallback when Serper does not return a high-confidence owner, behind APIFY_MAX_USD.',
    ca_note:
      'calicodev/calico developer API is government-agencies-only. Public bizfileOnline + SI; Apify Playwright + residential when Incapsula/Imperva blocks datacenter IPs. ca_batch / --ca-batch: one sticky Playwright session (groups-RESIDENTIAL), Incapsula once, then hundreds of companies (search + SI PDF).',
    ca_batch_usd_50: estimateCaBatchUsd(50),
    ca_batch_probe:
      'npx tsx scripts/owner_lookup_sample.ts --in ca-50.csv --out ca-50-results.csv --ca-batch --states CA --no-serper',
  };
}

function namelessSample(result: NameLookupResult): BusinessOwnerNamelessSample {
  return {
    source: result.source,
    coverage_reason: result.coverage_reason,
    implemented: result.implemented,
    match_method: result.match_method ?? null,
    people_count: result.people.length,
    waterfall_ready: result.people.some((p) => isWaterfallReady(p)),
    via_apify: result.via_apify,
    via_serper: result.via_serper,
    ocr_used: result.ocr_used,
  };
}

function capRows(rows: NameLookupInput[], maxRows?: number): NameLookupInput[] {
  const cap = Math.max(1, Math.min(maxRows ?? 500, MAX_BATCH_ROWS));
  return rows.slice(0, cap);
}

function emptySnapshot(
  jobId: string,
  opts: LookupBusinessOwnerOpts,
  remaining: number,
  estimateUsd: number,
  serperCredits = 0,
  serperUsd = 0,
): BusinessOwnerJobSnapshot {
  return {
    job_id: jobId,
    status: 'queued',
    dry_run: opts.dry_run !== false,
    estimate_only: opts.estimate_only === true,
    processed: 0,
    named: 0,
    agent_only: 0,
    remaining,
    hit_rate_by_state: {},
    apify_estimate_usd: estimateUsd,
    apify_usd_spent: 0,
    apify_compute_units: 0,
    apify_proxy_gb: 0,
    ca_batch: opts.ca_batch === true,
    via_apify: 0,
    serper_estimate_credits: serperCredits,
    serper_estimate_usd: serperUsd,
    serper_credits: 0,
    serper_usd: 0,
    via_serper: 0,
    ocr_used: 0,
    writes_enabled: WRITES_ENABLED,
    phase: OWNER_LOOKUP_PHASE,
    sample: [],
    started_at: new Date().toISOString(),
  };
}

function applyLookupHit(
  snapshot: BusinessOwnerJobSnapshot,
  row: NameLookupInput,
  result: NameLookupResult,
  samples: BusinessOwnerNamelessSample[],
  total: number,
): void {
  const st = normalizeState(row.state) || 'UNK';
  const stats = snapshot.hit_rate_by_state[st] ?? emptyStateStats();
  stats.attempted += 1;
  const named =
    result.source === 'ca_bizfile'
      ? Boolean(result.entity_id) && result.people.some((p) => isWaterfallReady(p))
      : result.people.some((p) => isWaterfallReady(p));
  if (named) stats.named += 1;
  if (result.coverage_reason === 'agent_only') stats.agent_only += 1;
  stats.hit_rate = stats.attempted ? Number((stats.named / stats.attempted).toFixed(3)) : 0;
  snapshot.hit_rate_by_state[st] = stats;
  snapshot.processed += 1;
  snapshot.remaining = Math.max(0, total - snapshot.processed);
  if (named) snapshot.named += 1;
  if (result.coverage_reason === 'agent_only') snapshot.agent_only += 1;
  if (result.via_apify) snapshot.via_apify += 1;
  if (result.via_serper || (result.serper_credits || 0) > 0) snapshot.via_serper += 1;
  if (result.ocr_used) snapshot.ocr_used += 1;
  snapshot.apify_usd_spent = Number((snapshot.apify_usd_spent + (result.apify_usd || 0)).toFixed(4));
  snapshot.serper_credits += result.serper_credits || 0;
  snapshot.serper_usd = Number((snapshot.serper_usd + (result.serper_usd || 0)).toFixed(4));
  if (samples.length < 10) samples.push(namelessSample(result));
}

async function runLookupJob(
  snapshot: BusinessOwnerJobSnapshot,
  rows: NameLookupInput[],
  opts: LookupBusinessOwnerOpts,
): Promise<BusinessOwnerJobSnapshot> {
  patchJob(snapshot.job_id, { status: 'running' });
  const ctx = defaultLookupContext({
    ...(opts.context || {}),
    includeAgents: opts.include_agents === true || opts.context?.includeAgents === true,
    live: opts.context?.live ?? true,
  });
  const lanes = Math.max(1, Math.min(opts.concurrency ?? SOS_HTTP_LANES, 8));
  const samples: BusinessOwnerNamelessSample[] = [];
  try {
    const caBatch = opts.ca_batch === true;
    snapshot.ca_batch = caBatch;
    const caRows = caBatch ? rows.filter((row) => normalizeState(row.state) === 'CA') : [];
    const otherRows = caBatch ? rows.filter((row) => normalizeState(row.state) !== 'CA') : rows;
    const resolved: Array<{ row: NameLookupInput; result: NameLookupResult }> = [];
    if (caRows.length) {
      const batch = await runCaBatch(caRows, ctx, {
        jobId: snapshot.job_id,
        checkpointPath: ctx.caBatchCheckpointPath,
      });
      for (let i = 0; i < caRows.length; i++) {
        resolved.push({ row: caRows[i], result: batch.results[i] });
      }
    }
    if (otherRows.length) {
      const rest = await mapPool(otherRows, lanes, async (row) => ({
        row,
        result: await resolveNameLookup(row, ctx),
      }));
      resolved.push(...rest);
    }
    for (const { row, result } of resolved) {
      applyLookupHit(snapshot, row, result, samples, rows.length);
    }
    snapshot.sample = samples;
    snapshot.apify_usd_spent = Number((ctx.spend?.usd ?? snapshot.apify_usd_spent).toFixed(2));
    snapshot.apify_compute_units = Number((ctx.spend?.computeUnits ?? snapshot.apify_compute_units ?? 0).toFixed(4));
    snapshot.apify_proxy_gb = Number((ctx.spend?.proxyGb ?? snapshot.apify_proxy_gb ?? 0).toFixed(4));
    if (ctx.serper) {
      snapshot.serper_credits = ctx.serper.credits;
      snapshot.serper_usd = ctx.serper.usd;
    }
    snapshot.remaining = 0;
    snapshot.status = 'completed';
    snapshot.finished_at = new Date().toISOString();
    putJob(snapshot);
    return snapshot;
  } catch (err) {
    snapshot.status = 'failed';
    snapshot.error = err instanceof Error ? err.message : 'lookup failed';
    snapshot.finished_at = new Date().toISOString();
    snapshot.sample = samples;
    snapshot.apify_compute_units = Number((ctx.spend?.computeUnits ?? snapshot.apify_compute_units ?? 0).toFixed(4));
    snapshot.apify_proxy_gb = Number((ctx.spend?.proxyGb ?? snapshot.apify_proxy_gb ?? 0).toFixed(4));
    putJob(snapshot);
    return snapshot;
  }
}

export async function lookupBusinessOwner(opts: LookupBusinessOwnerOpts): Promise<Record<string, unknown>> {
  const jobId = opts.job_id?.trim() || newJobId();
  const dryRun = opts.dry_run !== false;
  const estimateOnly = opts.estimate_only === true;
  const states = (opts.states || []).map(normalizeState).filter(Boolean);
  const filtered = (opts.rows || []).filter((row) => !states.length || states.includes(normalizeState(row.state)));
  const rows = capRows(filtered, opts.max_rows);

  if (estimateOnly) {
    const n = rows.length || FIRST_USE_ASSUMED_TOTAL;
    const caBatch = opts.ca_batch === true;
    const caCount = rows.filter((row) => normalizeState(row.state) === 'CA').length;
    const serperN = caBatch ? Math.max(0, (rows.length ? rows.length - caCount : n)) : n;
    const apifyUsd = rows.length ? estimateApifyUsd(rows, { ca_batch: caBatch }) : caBatch ? estimateCaBatchUsd(n) : 0;
    const serperCredits = estimateSerperCredits(serperN);
    const serperUsd = estimateSerperUsd(serperN);
    const snapshot = emptySnapshot(jobId, opts, 0, apifyUsd, serperCredits, serperUsd);
    snapshot.status = 'completed';
    snapshot.estimate_only = true;
    snapshot.processed = 0;
    snapshot.remaining = rows.length || FIRST_USE_ASSUMED_TOTAL;
    snapshot.finished_at = new Date().toISOString();
    putJob(snapshot);
    return {
      ok: true,
      ...snapshot,
      rows_in_payload: rows.length,
      source_table: opts.source_table || null,
      where: opts.where ? '(redacted)' : null,
      states: states.length ? states : catalogInRolloutOrder().map((r) => r.code),
      rollout_order: catalogInRolloutOrder().map((r) => r.code),
      runtime_seconds: estimateRuntimeSeconds(rows.length || FIRST_USE_ASSUMED_TOTAL),
      first_use: firstUseEnvelope(),
      writes_enabled: WRITES_ENABLED,
      josh_signup: [
        'Set SERPER_API_KEY (google.serper.dev). Serper is the first owner tier for every state — much cheaper than Apify.',
        'Do not sign up at calicodev.sos.ca.gov — the developer API is government-agencies-only',
        'Confirm Apify CU + residential GB (APIFY_TOKEN, groups-RESIDENTIAL). Set APIFY_MAX_USD as a hard cap. ca_batch / --ca-batch: one Playwright session for CA (Incapsula once, then hundreds of companies). Apify otherwise runs only when Serper misses.',
        'Optional: CA weekly bulk if it includes Statement of Information officers',
        'Illinois Data Transparency Act bulk zips auto-download from ilsos.gov/data/bs (or set IL_DTA_DIR). Search UI scrape is forbidden; missing files are no_source.',
      ],
      assistant_instructions:
        'Phase 2 estimate only. No SOS calls. No writes. Do not dump company names. Show Serper credits/$, Apify fallback envelope, and IL-file setup. CA has no API key (calicodev is government-only).',
    };
  }

  if (opts.source_table && !rows.length) {
    return {
      ok: false,
      job_id: jobId,
      error: 'source_table paging is not enabled in this PR (no Supabase writes). Pass rows[] or use scripts/owner_lookup_sample.ts.',
      writes_enabled: WRITES_ENABLED,
      phase: OWNER_LOOKUP_PHASE,
    };
  }

  if (opts.list_id && !rows.length) {
    return {
      ok: false,
      job_id: jobId,
      error: 'list_id fetch is not implemented on the name path. Permit lists still use match_state_owners.',
      writes_enabled: WRITES_ENABLED,
      phase: OWNER_LOOKUP_PHASE,
    };
  }

  const caBatch = opts.ca_batch === true;
  const caCount = rows.filter((row) => normalizeState(row.state) === 'CA').length;
  const serperN = caBatch ? Math.max(0, rows.length - caCount) : rows.length;
  const snapshot = emptySnapshot(
    jobId,
    { ...opts, dry_run: dryRun },
    rows.length,
    estimateApifyUsd(rows, { ca_batch: caBatch }),
    estimateSerperCredits(serperN),
    estimateSerperUsd(serperN),
  );
  snapshot.status = 'running';
  putJob(snapshot);

  const wait = opts.wait !== false;
  if (!wait) {
    void runLookupJob(snapshot, rows, opts);
    return {
      ok: true,
      ...getJob(jobId),
      assistant_instructions: 'Job running. Poll get_business_owner_job. Counts only. No Supabase writes.',
    };
  }

  const done = await runLookupJob(snapshot, rows, opts);
  return {
    ok: done.status !== 'failed',
    ...done,
    dry_run: dryRun,
    writes_enabled: WRITES_ENABLED,
    assistant_instructions: dryRun
      ? 'Phase 2 dry lookup. Counts only. No Supabase writes. Permit path is still match_state_owners.'
      : 'Phase 2 refuses production writes. Re-run dry_run=true. Persist is a later PR.',
  };
}

export async function getBusinessOwnerJob(jobId: string): Promise<Record<string, unknown>> {
  const id = String(jobId || '').trim();
  if (!id) return { ok: false, error: 'job_id required' };
  const row = getJob(id);
  if (!row) return { ok: false, error: 'job not found', job_id: id };
  return {
    ok: true,
    ...row,
    assistant_instructions: 'Counts and status only. Do not dump names.',
  };
}
