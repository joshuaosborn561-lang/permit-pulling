import { isChallengePage } from '../http.js';
import {
  hasCompanyWord,
  isPlaceName,
  isRegistryAgentName,
  namesMatchNormalized,
  normalizeCompanyName,
  normalizeState,
  splitPersonName,
  trigramSimilarity,
  validateOfficerPersonName,
} from '../names.js';
import type { OwnerConfidence, OwnerRole } from '../types.js';
import { catalogByCode } from './catalog.js';
import type { LookupContext } from './context.js';
import { ctxSerper } from './context.js';
import {
  CAP_NAME_CAPTURE,
  TITLE_BOUNDED,
  isOfficerTitle,
  parseOfficerRoster,
  roleFromTitle,
  scrubCapitalizedPersonName,
  type RosterEntry,
} from './officers.js';
import { organicFromSerperPayload, serperSearch } from './serper.js';
import { SERPER_USD_PER_QUERY } from './spend.js';
import type { NameLookupInput, NameLookupResult, SerperOrganicHit, WaterfallOwnerHit } from './types.js';
import { isWaterfallReady } from './waterfall.js';

const SKIP_HOST =
  /(^|\.)(linkedin|facebook|instagram|youtube|twitter|x\.com|reddit|pinterest|tiktok|wikipedia|indeed|glassdoor|yelp|yellowpages|bbb\.org|maps\.google)(\.|$)/i;

const TRUSTED_HOST = /(^|\.)(opencorporates\.com|bizapedia\.com|sunbiz\.org)$/i;

export const SERPER_HIGH_SCORE = 0.8;
/** Raised from 0.48 so weak trigram windows cannot tie a different company. */
export const SERPER_COMPANY_TRIGRAM = 0.62;

const TRUSTED_SITE_HOSTS = ['opencorporates.com', 'bizapedia.com', 'sunbiz.org'] as const;

const LEADERSHIP_TITLE = /\b(owner|founder|president|ceo|chief\s+executive(\s+officer)?)\b/i;

export function sosHostForState(state: string): string | null {
  const entry = catalogByCode().get(normalizeState(state));
  if (!entry?.search_url) return null;
  try {
    return new URL(entry.search_url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

export function stateFullName(state: string): string {
  return catalogByCode().get(normalizeState(state))?.name || String(state || '').trim();
}

export function serperOfficerQuery(input: NameLookupInput): string {
  const company = String(input.company_name || '').trim();
  const city = String(input.city || '').trim();
  const state = normalizeState(input.state);
  const full = stateFullName(state);
  return [company, city, full || state, 'officer OR owner OR CEO OR president OR manager']
    .filter(Boolean)
    .join(' ');
}

function siteQuery(host: string, input: NameLookupInput): string {
  const company = String(input.company_name || '').trim();
  const city = String(input.city || '').trim();
  const state = normalizeState(input.state);
  const full = stateFullName(state);
  return `site:${host} "${company}" ${city} ${full || state} officer OR owner OR CEO OR president OR manager`.replace(
    /\s+/g,
    ' ',
  );
}

/** One Google query per trusted registry — combined `site:a OR site:b` never ranked those pages. */
export function serperSiteQueries(input: NameLookupInput): string[] {
  const hosts: string[] = [...TRUSTED_SITE_HOSTS];
  const sos = sosHostForState(input.state);
  if (sos && !hosts.some((h) => sos === h || sos.endsWith(`.${h}`) || h.endsWith(`.${sos}`))) {
    hosts.push(sos);
  }
  return hosts.map((host) => siteQuery(host, input));
}

export function serperQueriesFor(input: NameLookupInput): string[] {
  return [serperOfficerQuery(input), ...serperSiteQueries(input)];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

export function isSkippedSerperHost(url: string): boolean {
  const host = hostOf(url);
  if (!host) return true;
  return SKIP_HOST.test(host);
}

export function isTrustedSerperHost(url: string, state: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (TRUSTED_HOST.test(host)) return true;
  if (/\.gov$/i.test(host) && /(sos|corp|azcc|sec\.state|sunbiz|ccfs|dcca|lara)/i.test(host)) return true;
  const sos = sosHostForState(state);
  if (sos && (host === sos || host.endsWith(`.${sos}`))) return true;
  return false;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function blobHasCity(blob: string, city?: string | null): boolean {
  const raw = String(city || '')
    .replace(/[^A-Za-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (raw.length < 3) return false;
  return new RegExp(`\\b${escapeRe(raw)}\\b`, 'i').test(blob);
}

export function blobHasState(blob: string, state: string): boolean {
  const code = normalizeState(state);
  const full = stateFullName(code);
  if (full && new RegExp(`\\b${escapeRe(full)}\\b`, 'i').test(blob)) return true;
  return new RegExp(`[,(\\[]\\s*${escapeRe(code)}\\b|\\b${escapeRe(code)}\\s*\\)|\\b${escapeRe(code)}\\s+\\d{5}\\b`, 'i').test(
    blob,
  );
}

export function companyTiedToBlob(
  company: string,
  blob: string,
): { method: 'exact' | 'substring' | 'trigram'; score: number } | null {
  const key = normalizeCompanyName(company);
  const hay = normalizeCompanyName(blob);
  if (!key || key.length < 3 || !hay) return null;
  if (hay === key || hay.includes(key)) {
    const method = hay === key ? 'exact' : 'substring';
    return { method, score: method === 'exact' ? 1 : 0.85 };
  }
  const keyTokens = key.split(' ');
  const hayTokens = hay.split(' ');
  if (!hayTokens.length) return null;
  let best = 0;
  const window = Math.max(keyTokens.length, 2);
  for (let i = 0; i < hayTokens.length; i++) {
    const slice = hayTokens.slice(i, i + window + 1).join(' ');
    const tri = trigramSimilarity(company, slice);
    if (tri > best) best = tri;
  }
  const whole = trigramSimilarity(company, blob);
  if (whole > best) best = whole;
  if (best >= SERPER_COMPANY_TRIGRAM) return { method: 'trigram', score: best };
  return null;
}

function stripTrailingGeo(name: string, input: NameLookupInput): string {
  const tails = [stateFullName(input.state), String(input.city || '').trim(), normalizeState(input.state)]
    .filter((t) => String(t).length >= 2)
    .sort((a, b) => String(b).length - String(a).length);
  let s = name;
  for (const tail of tails) {
    s = s.replace(new RegExp(`[,\\s]+${escapeRe(String(tail))}\\s*$`, 'i'), '').trim();
  }
  return s;
}

function usablePersonName(name: string, company: string, input?: NameLookupInput): boolean {
  const geoStripped = input ? stripTrailingGeo(name, input) : name;
  const cleaned = scrubCapitalizedPersonName(geoStripped);
  if (!cleaned) return false;
  if (isRegistryAgentName(cleaned)) return false;
  if (hasCompanyWord(cleaned)) return false;
  if (isPlaceName(cleaned, [input?.city])) return false;
  if (namesMatchNormalized(cleaned, company)) return false;
  if (!validateOfficerPersonName(cleaned, [input?.city]).ok) return false;
  return true;
}

function extraSnippetEntries(text: string, company: string, input?: NameLookupInput): RosterEntry[] {
  const out: RosterEntry[] = [];
  const seen = new Set<string>();
  const push = (name: string, title: string, labeled: boolean) => {
    const geoStripped = input ? stripTrailingGeo(name, input) : name;
    const cleaned = scrubCapitalizedPersonName(geoStripped);
    if (!cleaned || !usablePersonName(cleaned, company, input)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: cleaned,
      title: String(title || 'Officer').replace(/\s+/g, ' ').trim(),
      role: roleFromTitle(title),
      labeled,
    });
  };

  // No /i/ flag — name tokens must start with a capital letter.
  const isThe = new RegExp(
    `\\b${CAP_NAME_CAPTURE}\\s+[Ii][Ss]\\s+(?:(?:[Tt][Hh][Ee])\\s+)?(${TITLE_BOUNDED})\\b`,
    'g',
  );
  for (const m of text.matchAll(isThe)) push(m[1] || '', m[2] || 'Officer', false);

  const dash = new RegExp(`\\b${CAP_NAME_CAPTURE}\\s*[-–—]\\s*(${TITLE_BOUNDED})\\b`, 'g');
  for (const m of text.matchAll(dash)) push(m[1] || '', m[2] || 'Officer', false);

  const titleFirst = new RegExp(`\\b(${TITLE_BOUNDED})\\s+${CAP_NAME_CAPTURE}\\b`, 'g');
  for (const m of text.matchAll(titleFirst)) {
    if (isOfficerTitle(m[2] || '')) continue;
    push(m[2] || '', m[1] || 'Officer', false);
  }

  return out;
}

export function officersFromSerperBlob(blob: string, company: string, input?: NameLookupInput): RosterEntry[] {
  const roster = parseOfficerRoster(blob).filter(
    (row) => usablePersonName(row.name, company, input) && row.role !== 'registered_agent',
  );
  const extra = extraSnippetEntries(blob, company, input);
  const seen = new Set(roster.map((r) => r.name.toLowerCase()));
  for (const row of extra) {
    if (seen.has(row.name.toLowerCase())) continue;
    seen.add(row.name.toLowerCase());
    roster.push(row);
  }
  return roster;
}

function confidenceFromScore(score: number): OwnerConfidence {
  if (score >= SERPER_HIGH_SCORE) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

function exactCompanyInBlob(method: 'exact' | 'substring' | 'trigram'): boolean {
  return method === 'exact' || method === 'substring';
}

function isLeadershipTitle(title: string): boolean {
  return LEADERSHIP_TITLE.test(title || '');
}

export interface SerperCandidate {
  entry: RosterEntry;
  source_url: string;
  score: number;
  confidence: OwnerConfidence;
  company_method: 'exact' | 'substring' | 'trigram';
  trusted: boolean;
}

function scoreEntry(
  input: NameLookupInput,
  entry: RosterEntry,
  url: string,
  companyHit: { method: 'exact' | 'substring' | 'trigram'; score: number },
  cityOk: boolean,
  stateOk: boolean,
): SerperCandidate | null {
  const trusted = isTrustedSerperHost(url, input.state);
  const leadership = isLeadershipTitle(entry.title);
  const exactCompany = exactCompanyInBlob(companyHit.method);
  let score = 0;
  if (companyHit.method === 'exact') score += 0.4;
  else if (companyHit.method === 'substring') score += 0.3;
  else score += Math.min(0.22, companyHit.score * 0.3);
  if (cityOk) score += 0.15;
  if (stateOk) score += 0.15;
  if (trusted) score += 0.15;
  if (entry.labeled) score += 0.08;
  if (leadership) score += 0.07;
  if (entry.title) score += 0.08;
  const split = splitPersonName(entry.name);
  if (split.first_name && split.last_name) score += 0.1;
  score = Math.min(1, Number(score.toFixed(3)));

  const strongUntrusted = !trusted && leadership && exactCompany && cityOk;
  if (!trusted && score >= SERPER_HIGH_SCORE && !strongUntrusted) {
    score = 0.79;
  }
  if (trusted && score >= SERPER_HIGH_SCORE && !(cityOk && stateOk) && companyHit.method === 'trigram') {
    score = 0.79;
  }

  const confidence = confidenceFromScore(score);
  if (confidence === 'low') return null;
  return {
    entry,
    source_url: url,
    score,
    confidence,
    company_method: companyHit.method,
    trusted,
  };
}

function rankCandidate(c: SerperCandidate): number {
  return c.score + (c.entry.labeled ? 0.05 : 0) + (c.trusted ? 0.02 : 0);
}

function betterCandidate(a: SerperCandidate | null, b: SerperCandidate): boolean {
  if (!a) return true;
  const rb = rankCandidate(b);
  const ra = rankCandidate(a);
  if (rb !== ra) return rb > ra;
  if (b.entry.labeled && !a.entry.labeled) return true;
  if (b.trusted && !a.trusted) return true;
  return false;
}

export function scoreSerperOrganic(
  input: NameLookupInput,
  hit: SerperOrganicHit,
): SerperCandidate | null {
  const cands = candidatesFromOrganic(input, hit);
  let best: SerperCandidate | null = null;
  for (const cand of cands) {
    if (betterCandidate(best, cand)) best = cand;
  }
  return best;
}

export function candidatesFromOrganic(input: NameLookupInput, hit: SerperOrganicHit): SerperCandidate[] {
  const url = String(hit.link || '').trim();
  const title = String(hit.title || '');
  const snippet = String(hit.snippet || '');
  const blob = `${title}\n${snippet}`;
  if (!url || isSkippedSerperHost(url)) return [];
  if (isChallengePage(blob) || isChallengePage(title) || isChallengePage(snippet)) return [];

  const companyHit = companyTiedToBlob(input.company_name, blob);
  if (!companyHit) return [];
  const cityOk = blobHasCity(blob, input.city);
  const stateOk = blobHasState(blob, input.state);
  if (!cityOk && !stateOk) return [];

  const officers = officersFromSerperBlob(blob, input.company_name, input);
  const out: SerperCandidate[] = [];
  for (const entry of officers) {
    const scored = scoreEntry(input, entry, url, companyHit, cityOk, stateOk);
    if (scored) out.push(scored);
  }
  return out;
}

function hitFromCandidate(input: NameLookupInput, cand: SerperCandidate): WaterfallOwnerHit {
  const split = splitPersonName(cand.entry.name);
  const role: OwnerRole = cand.entry.role;
  return {
    first_name: split.first_name,
    last_name: split.last_name,
    title: cand.entry.title || 'Officer',
    company_name: input.company_name,
    domain: input.domain ?? null,
    source_url: cand.source_url,
    confidence: cand.confidence,
    confidence_score: cand.score,
    state: input.state,
    source: 'serper',
    role,
    coverage_reason: null,
  };
}

function serperEmpty(_input: NameLookupInput, credits: number): NameLookupResult {
  return {
    people: [],
    coverage_reason: 'not_found',
    source: 'serper',
    implemented: true,
    via_serper: credits > 0,
    serper_credits: credits,
    serper_usd: Number((credits * SERPER_USD_PER_QUERY).toFixed(4)),
  };
}

export async function resolveSerperOwner(
  input: NameLookupInput,
  ctx?: LookupContext,
): Promise<NameLookupResult> {
  const company = String(input.company_name || '').trim();
  const state = normalizeState(input.state);
  if (!company || !state) return serperEmpty(input, 0);
  if (ctx?.serperEnabled === false) return serperEmpty(input, 0);

  const queries = serperQueriesFor(input);
  const before = ctxSerper(ctx).credits;
  const payloads = await Promise.all(queries.map((q) => serperSearch(q, ctx)));
  const credits = ctxSerper(ctx).credits - before;

  const organic: SerperOrganicHit[] = [];
  for (const payload of payloads) {
    organic.push(...organicFromSerperPayload(payload));
  }
  const kg = payloads[0]?.knowledgeGraph?.description;
  if (kg && organic[0]) {
    organic[0] = {
      ...organic[0],
      snippet: `${organic[0].snippet || ''} ${kg}`.trim(),
    };
  }

  let best: SerperCandidate | null = null;
  for (const row of organic) {
    for (const cand of candidatesFromOrganic(input, row)) {
      if (betterCandidate(best, cand)) best = cand;
    }
  }

  if (!best) return serperEmpty(input, credits);

  const person = hitFromCandidate(input, best);
  return {
    people: [person],
    coverage_reason: null,
    source: 'serper',
    source_url: person.source_url,
    match_method: best.company_method,
    match_score: Math.round(best.score * 100),
    business_name: input.company_name,
    implemented: true,
    via_serper: credits > 0,
    serper_credits: credits,
    serper_usd: Number((credits * SERPER_USD_PER_QUERY).toFixed(4)),
  };
}

export function serperIsHighConfidence(result: NameLookupResult | null | undefined): boolean {
  return Boolean(result?.people.some((p) => p.source === 'serper' && isWaterfallReady(p)));
}
