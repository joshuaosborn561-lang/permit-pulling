import { getBoardFetch, type FetchLike } from '../http.js';
import type { NameLookupInput } from './types.js';
import { ApifySpendTracker, SerperCreditTracker, apifyMaxUsdFromEnv } from './spend.js';
import type { IlDtaIndex } from './ilDta.js';
import type { SerperSearchResponse } from './types.js';

export type HtmlKind = 'search' | 'detail' | 'document';

export interface LookupContext {
  /** When true, adapters may call official HTTP / Apify. Tests leave this false. */
  live?: boolean;
  fetch?: FetchLike;
  apifyToken?: string | null;
  apifyEnabled?: boolean;
  ilDtaDir?: string | null;
  ilIndex?: IlDtaIndex | null;
  includeAgents?: boolean;
  spend?: ApifySpendTracker;
  serper?: SerperCreditTracker;
  serperKey?: string | null;
  serperEnabled?: boolean;
  /** Fixture: skip google.serper.dev and return this payload (or per-query). */
  serperOrganic?:
    | SerperSearchResponse
    | ((query: string) => SerperSearchResponse | Promise<SerperSearchResponse>);
  /** Fixture: skip CA HTTP and use this keyword-search JSON. */
  caPayload?: unknown;
  caDetailPayload?: unknown;
  caSiText?: string | null;
  caSiBytes?: Uint8Array | null;
  /** Fixture HTML keyed by state + kind, or a function. */
  htmlFor?: string | ((state: string, kind: HtmlKind, input: NameLookupInput, url?: string) => string | null);
  htmlByUrl?: Record<string, string>;
  /** Fixture rows for Colorado Socrata. */
  coRows?: unknown[];
  /** Fixture rows / payload for Ohio businessnamediv JSON. */
  ohRows?: unknown[];
  ohEndpoints?: unknown;
  /** Fixture payload for Arizona Business Center JSON. */
  azPayload?: unknown;
  azDetailPayload?: unknown;
  /** Hard cap for Apify spend this context. Env: APIFY_MAX_USD. */
  apifyMaxUsd?: number | null;
  /** Injected OCR (tests). Production uses tesseract.js when installed. */
  ocr?: (bytes: Uint8Array) => Promise<string>;
  /** Injected Apify HTML fetch (tests). */
  apifyFetchHtml?: (url: string) => Promise<{
    html: string;
    usd: number;
    text?: string;
    refused?: boolean;
    bytesBase64?: string;
    contentType?: string;
  }>;
  /** Host-side CA batch checkpoint path (resume). */
  caBatchCheckpointPath?: string;
  /** Dump per-step HTTP status from the Playwright run (CLI --ca-debug). */
  caBatchDebug?: boolean;
  /** Fixture dataset items — skip the live Playwright run. */
  caBatchItems?: Array<{
    company_name: string;
    city: string;
    state: string;
    status: 'ok' | 'not_found' | 'blocked' | 'error';
    retries: number;
    entity_id?: string;
    business_name?: string;
    match_method?: 'exact' | 'substring' | 'trigram';
    match_score?: number;
    source_url?: string;
    document_id?: string;
    officers_text?: string;
    bytesBase64?: string;
    contentType?: string;
    agent_name?: string;
    error?: string;
  }>;
}

export function apifyTokenFromEnv(): string | null {
  for (const name of ['APIFY_TOKEN', 'APIFY_API_TOKEN', 'apify_token'] as const) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return null;
}

export function ilDtaDirFromEnv(): string | null {
  return process.env.IL_DTA_DIR?.trim() || null;
}

export function serperKeyFromEnv(): string | null {
  for (const name of ['SERPER_API_KEY', 'SERPER_KEY', 'serper_api_key'] as const) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return null;
}

export function defaultLookupContext(overrides: LookupContext = {}): LookupContext {
  const ctx: LookupContext = {
    live: true,
    fetch: getBoardFetch(),
    apifyToken: apifyTokenFromEnv(),
    apifyEnabled: overrides.apifyEnabled ?? true,
    ilDtaDir: ilDtaDirFromEnv(),
    includeAgents: false,
    spend: overrides.spend ?? new ApifySpendTracker(),
    serper: overrides.serper ?? new SerperCreditTracker(),
    serperKey: overrides.serperKey ?? serperKeyFromEnv(),
    serperEnabled: overrides.serperEnabled ?? true,
    apifyMaxUsd: overrides.apifyMaxUsd ?? apifyMaxUsdFromEnv(),
    ...overrides,
  };
  if (ctx.spend && ctx.apifyMaxUsd != null) ctx.spend.capUsd = ctx.apifyMaxUsd;
  return ctx;
}

export function ctxFetch(ctx?: LookupContext): FetchLike {
  return ctx?.fetch ?? getBoardFetch();
}

export function ctxSpend(ctx?: LookupContext): ApifySpendTracker {
  if (ctx?.spend) return ctx.spend;
  const spend = new ApifySpendTracker();
  if (ctx) ctx.spend = spend;
  return spend;
}

export function ctxSerper(ctx?: LookupContext): SerperCreditTracker {
  if (ctx?.serper) return ctx.serper;
  const serper = new SerperCreditTracker();
  if (ctx) ctx.serper = serper;
  return serper;
}

export function fixtureHtml(ctx: LookupContext | undefined, state: string, kind: HtmlKind, input: NameLookupInput, url?: string): string | null {
  if (!ctx) return null;
  if (typeof ctx.htmlFor === 'function') return ctx.htmlFor(state, kind, input, url);
  if (typeof ctx.htmlFor === 'string') return ctx.htmlFor;
  if (url && ctx.htmlByUrl?.[url]) return ctx.htmlByUrl[url];
  return null;
}
