/** Starter-plan mid-point from PLAN.md (compute + residential, media off). */
export const APIFY_USD_PER_BLOCKED_LOOKUP = 0.015;
export const APIFY_USD_PER_COMPUTE_UNIT = 0.2;
/** CA search + SI may each need Playwright when Incapsula blocks datacenter IPs. */
export const CA_APIFY_LOOKUPS_PER_ROW = 1.5;
/** One sticky Playwright session: Incapsula once, then hundreds of CA companies. */
export const CA_BATCH_USD_BASE = 0.04;
export const CA_BATCH_USD_PER_COMPANY = 0.003;
export const CA_BATCH_COMPANIES_PER_RUN = 400;
export const CA_BATCH_ITEM_RETRIES = 3;
/** google.serper.dev search. One credit per query; Josh prefers this over Apify. */
export const SERPER_USD_PER_QUERY = 0.001;
/** Generic officer query + separate OpenCorporates, Bizapedia, Sunbiz, and state SOS queries. */
export const SERPER_QUERIES_PER_ROW = 5;

export function apifyMaxUsdFromEnv(): number | null {
  const raw = process.env.APIFY_MAX_USD?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export class ApifySpendTracker {
  usd = 0;
  runs = 0;
  lookups = 0;
  computeUnits = 0;
  refused = 0;
  proxyGb = 0;
  capUsd: number | null = apifyMaxUsdFromEnv();

  wouldExceed(additional = APIFY_USD_PER_BLOCKED_LOOKUP): boolean {
    if (this.capUsd == null) return false;
    return this.usd + (Number(additional) || 0) > this.capUsd;
  }

  refuse(): void {
    this.refused += 1;
  }

  add(usd: number, opts?: { cu?: number; lookups?: number; proxyGb?: number }): void {
    const extra = Number(usd) || 0;
    const gb = Number(opts?.proxyGb) || 0;
    if (extra <= 0 && !opts?.cu && gb <= 0) return;
    this.usd = Number((this.usd + extra).toFixed(4));
    this.runs += 1;
    this.lookups += opts?.lookups ?? 1;
    if (opts?.cu) this.computeUnits += opts.cu;
    if (gb > 0) this.proxyGb = Number((this.proxyGb + gb).toFixed(6));
  }

  snapshot(): {
    apify_usd_spent: number;
    apify_runs: number;
    apify_lookups: number;
    apify_compute_units: number;
    apify_proxy_gb: number;
  } {
    return {
      apify_usd_spent: Number(this.usd.toFixed(2)),
      apify_runs: this.runs,
      apify_lookups: this.lookups,
      apify_compute_units: Number(this.computeUnits.toFixed(4)),
      apify_proxy_gb: Number(this.proxyGb.toFixed(4)),
    };
  }
}

export class SerperCreditTracker {
  credits = 0;
  queries = 0;

  add(credits = 1): void {
    const n = Number(credits) || 0;
    if (n <= 0) return;
    this.credits += n;
    this.queries += 1;
  }

  get usd(): number {
    return Number((this.credits * SERPER_USD_PER_QUERY).toFixed(4));
  }

  snapshot(): { serper_credits: number; serper_queries: number; serper_usd: number } {
    return {
      serper_credits: this.credits,
      serper_queries: this.queries,
      serper_usd: this.usd,
    };
  }
}

export function estimateSerperCredits(rowCount: number): number {
  return Math.max(0, rowCount) * SERPER_QUERIES_PER_ROW;
}

export function estimateSerperUsd(rowCount: number): number {
  return Number((estimateSerperCredits(rowCount) * SERPER_USD_PER_QUERY).toFixed(4));
}

export function proxyGbFromApifyRun(
  run: {
    usage?: Record<string, number>;
    stats?: { netRxBytes?: number; netTxBytes?: number };
  } | null | undefined,
): number {
  const usage = run?.usage || {};
  const fromUsage = Number(
    usage.PROXY_RESIDENTIAL_TRANSFER_GBYTES ||
      usage.PROXY_RESIDENTIAL_GBYTES ||
      usage['proxy-residential-transfer-gbytes'] ||
      0,
  );
  if (fromUsage > 0) return Number(fromUsage.toFixed(6));
  const bytes = Number(run?.stats?.netRxBytes || 0) + Number(run?.stats?.netTxBytes || 0);
  if (bytes > 0) return Number((bytes / 1e9).toFixed(6));
  return 0;
}

export function usdFromApifyRun(
  run: {
    usageTotalUsd?: number;
    usage?: Record<string, number>;
    stats?: { computeUnits?: number; netRxBytes?: number; netTxBytes?: number };
    status?: string;
  } | null | undefined,
  opts?: { succeeded?: boolean },
): {
  usd: number;
  cu: number;
  proxyGb: number;
} {
  const cu = Number(run?.stats?.computeUnits || run?.usage?.ACTOR_COMPUTE_UNITS || 0);
  const proxyGb = proxyGbFromApifyRun(run);
  const succeeded = opts?.succeeded ?? run?.status === 'SUCCEEDED';
  if (typeof run?.usageTotalUsd === 'number' && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd > 0) {
    return { usd: run.usageTotalUsd, cu, proxyGb };
  }
  if (cu > 0) return { usd: cu * APIFY_USD_PER_COMPUTE_UNIT, cu, proxyGb };
  // Refused / failed / never-started runs do not get the per-lookup estimate.
  if (!succeeded) return { usd: 0, cu: 0, proxyGb };
  return { usd: APIFY_USD_PER_BLOCKED_LOOKUP, cu: 0, proxyGb };
}

export function estimateCaBatchUsd(companyCount: number): number {
  if (companyCount <= 0) return 0;
  const runs = Math.ceil(companyCount / CA_BATCH_COMPANIES_PER_RUN);
  return Number((runs * CA_BATCH_USD_BASE + companyCount * CA_BATCH_USD_PER_COMPANY).toFixed(2));
}

export const CA_HYBRID_MAX_RESULTS_DEFAULT = 3;

/** Ceiling for dz_omar search+history (one run) plus web-fetch SI PDFs. FREE-tier event prices. */
export function estimateCaHybridUsd(
  companyCount: number,
  maxResultsPerQuery = CA_HYBRID_MAX_RESULTS_DEFAULT,
): number {
  const n = Math.max(0, companyCount);
  if (!n) return 0;
  const perRecord = Math.max(1, Math.min(50, Math.floor(maxResultsPerQuery) || CA_HYBRID_MAX_RESULTS_DEFAULT));
  const start = 0.005;
  const search = 0.025 * n;
  const records = 0.003 * n * perRecord;
  const history = 0.004 * n * perRecord;
  const pdf = 0.002 * n;
  return Number((start + search + records + history + pdf).toFixed(2));
}
