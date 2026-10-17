/** Shared contract for per-state owner / qualifying-individual resolvers. */

export const OWNER_ROLES = [
  'owner',
  'qualifying_individual',
  'officer',
  'registered_agent',
  'member',
  'sole_proprietor',
] as const;

export type OwnerRole = (typeof OWNER_ROLES)[number];

export const COVERAGE_REASONS = [
  'not_found',
  'inactive_license',
  'inactive',
  'no_license_number',
  'sole_prop_dba',
  'blocked',
  'parse_error',
  'name_miss',
  'no_source',
  'agent_only',
  'missing_key',
  'not_implemented',
] as const;

export type CoverageReason = (typeof COVERAGE_REASONS)[number];

export const BOARD_SOURCES = [
  'cslb',
  'sunbiz',
  'tx_sos',
  'tx_tdlr',
  'wa_lni',
  'nyc_dob',
  'ny_dos',
  'ma_csl',
  'ma_sos',
  'mn_dli',
  'pa_hic',
  'pa_dos',
  'ca_bizfile',
  'us_sos',
  'serper',
] as const;

export type BoardSource = (typeof BOARD_SOURCES)[number];

export type OwnerConfidence = 'high' | 'medium' | 'low';

export interface OwnerPerson {
  first_name: string | null;
  last_name: string | null;
  full_name_raw: string;
  role: OwnerRole;
  source: BoardSource;
  source_url: string;
  confidence: OwnerConfidence;
  business_phone?: string | null;
  review_flag?: boolean;
}

export interface OwnerLead {
  list_id: string;
  lead_id: number;
  company_name: string;
  contact_name?: string | null;
  city?: string | null;
  state?: string | null;
  license_number?: string | null;
  contractor_id?: string | null;
  place_id?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface ResolverResult {
  people: OwnerPerson[];
  coverage_reason: CoverageReason | null;
  source: BoardSource;
  source_url?: string | null;
  license_status?: string | null;
  entity?: string | null;
  business_name?: string | null;
  business_phone?: string | null;
  cached?: boolean;
  http_status?: number | null;
  blocked?: boolean;
  /** True when the page is Turnstile/captcha. Never retry those through a proxy. */
  captcha?: boolean;
  /** How the company name was matched. Used for precision reports, not chat. */
  match_method?: 'exact' | 'substring' | 'trigram' | 'license';
  match_score?: number;
}

export class BoardJobStopError extends Error {
  readonly consecutive: number;
  readonly status: number;
  readonly source: BoardSource;

  constructor(source: BoardSource, consecutive: number, status: number) {
    super(`${source} stopped after ${consecutive} consecutive HTTP ${status}`);
    this.name = 'BoardJobStopError';
    this.source = source;
    this.consecutive = consecutive;
    this.status = status;
  }
}

export interface SampleOwnerRow {
  role: OwnerRole | null;
  source: BoardSource;
  confidence: OwnerConfidence | null;
  coverage_reason: CoverageReason | null;
  review_flag?: boolean;
  has_business_phone?: boolean;
  match_method?: ResolverResult['match_method'] | null;
  match_score?: number | null;
}

export function sampleOwnerRows(
  results: Array<{
    people: OwnerPerson[];
    coverage_reason: CoverageReason | null;
    source: BoardSource;
    match_method?: ResolverResult['match_method'];
    match_score?: number;
  }>,
  n = 10,
): SampleOwnerRow[] {
  return results.slice(0, n).map((r) => {
    const person = r.people[0];
    return {
      role: person?.role ?? null,
      source: r.source,
      confidence: person?.confidence ?? null,
      coverage_reason: r.coverage_reason,
      review_flag: person?.review_flag,
      has_business_phone: Boolean(person?.business_phone || null),
      match_method: r.match_method ?? null,
      match_score: r.match_score ?? null,
    };
  });
}
