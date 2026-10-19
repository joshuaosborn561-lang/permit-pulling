import type { BoardSource, CoverageReason, OwnerConfidence, OwnerRole } from '../types.js';

export interface SerperOrganicHit {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

export interface SerperSearchResponse {
  organic?: SerperOrganicHit[];
  knowledgeGraph?: { title?: string; description?: string | null };
  credits?: number;
}

export type OfficerYield = 'officers' | 'agent_only' | 'filings_pdf' | 'none';
export type SosAccess = 'api_key' | 'open_data' | 'bulk_file' | 'html' | 'reuse_adapter' | 'none';
export type ApifyPolicy = 'fallback' | 'never' | 'already_proxied';

export interface StateSosCatalogEntry {
  code: string;
  name: string;
  office: string;
  search_url: string;
  access: SosAccess;
  officers: OfficerYield;
  signup: string;
  rate_limit: string;
  anti_bot: string;
  apify: ApifyPolicy;
  implement_order: number;
  notes: string;
  existing_adapter?: string;
}

export interface NameLookupInput {
  company_name: string;
  city?: string | null;
  state: string;
  domain?: string | null;
  license_number?: string | null;
  list_id?: string;
  lead_id?: number;
}

/** Fields Email Finder Waterfall name_company mode can consume. Never dump in chat. */
export interface WaterfallOwnerHit {
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company_name: string;
  domain: string | null;
  source_url: string;
  confidence: OwnerConfidence;
  /** 0–1. Serper high-confidence waterfall_ready requires >= 0.8. */
  confidence_score?: number;
  state: string;
  source: BoardSource;
  role: OwnerRole;
  coverage_reason: CoverageReason | null;
  review_flag?: boolean;
  match_method?: 'exact' | 'substring' | 'trigram' | 'license';
  city_match?: boolean;
}

export interface NameLookupResult {
  people: WaterfallOwnerHit[];
  coverage_reason: CoverageReason | null;
  source: BoardSource;
  source_url?: string | null;
  match_method?: 'exact' | 'substring' | 'trigram' | 'license';
  match_score?: number;
  entity_id?: string | null;
  business_name?: string | null;
  implemented: boolean;
  apify_usd?: number;
  via_apify?: boolean;
  ocr_used?: boolean;
  via_serper?: boolean;
  serper_credits?: number;
  serper_usd?: number;
}

export type BusinessOwnerJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

export interface BusinessOwnerJobHitRate {
  attempted: number;
  named: number;
  agent_only: number;
  hit_rate: number;
}

export interface BusinessOwnerNamelessSample {
  source: BoardSource;
  coverage_reason: CoverageReason | null;
  implemented: boolean;
  match_method: NameLookupResult['match_method'] | null;
  people_count: number;
  waterfall_ready: boolean;
  via_apify?: boolean;
  via_serper?: boolean;
  ocr_used?: boolean;
}

export interface BusinessOwnerJobSnapshot {
  job_id: string;
  status: BusinessOwnerJobStatus;
  dry_run: boolean;
  estimate_only: boolean;
  processed: number;
  named: number;
  agent_only: number;
  remaining: number;
  hit_rate_by_state: Record<string, BusinessOwnerJobHitRate>;
  apify_estimate_usd: number;
  apify_usd_spent: number;
  apify_compute_units?: number;
  apify_proxy_gb?: number;
  ca_batch?: boolean;
  ca_debug?: boolean;
  via_apify: number;
  serper_estimate_credits: number;
  serper_estimate_usd: number;
  serper_credits: number;
  serper_usd: number;
  via_serper: number;
  ocr_used: number;
  writes_enabled: boolean;
  phase: number;
  sample?: BusinessOwnerNamelessSample[];
  error?: string;
  started_at?: string;
  finished_at?: string;
}
