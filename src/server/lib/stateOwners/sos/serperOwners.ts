import { isChallengePage } from '../http.js';
import {
  hasCompanyWord,
  isRegistryAgentName,
  namesMatchNormalized,
  normalizeCompanyName,
  normalizeState,
  splitPersonName,
  trigramSimilarity,
} from '../names.js';
import type { OwnerConfidence, OwnerRole } from '../types.js';
import { catalogByCode } from './catalog.js';
import type { LookupContext } from './context.js';
import { ctxSerper } from './context.js';
import { isOfficerTitle, parseOfficerRoster, roleFromTitle, type RosterEntry } from './officers.js';
import { organicFromSerperPayload, serperSearch } from './serper.js';
import { SERPER_USD_PER_QUERY } from './spend.js';
import type { NameLookupInput, NameLookupResult, SerperOrganicHit, WaterfallOwnerHit } from './types.js';
import { isWaterfallReady } from './waterfall.js';

const TITLE =
  'Chief\\s+Executive\\s+Officer|Chief\\s+Financial\\s+Officer|Chief\\s+Operating\\s+Officer|' +
  'President|Vice\\s+President|Secretary|Treasurer|Director|Manager|Managing\\s+Member|Member|' +
  'CEO|CFO|COO|VP|Governor|Partner|Principal|Owner|Organizer|Officer';
const TITLE_BOUNDED = `\\b(?:${TITLE})\\b`;

const SKIP_HOST =
  /(^|\.)(linkedin|facebook|instagram|youtube|twitter|x\.com|reddit|pinterest|tiktok|wikipedia|indeed|glassdoor|yelp|yellowpages|bbb\.org|maps\.google)(\.|$)/i;

const TRUSTED_HOST = /(^|\.)(opencorporates\.com|bizapedia\.com)$/i;

export const SERPER_HIGH_SCORE = 0.8;

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

export function serperSiteQuery(input: NameLookupInput): string {
  const company = String(input.company_name || '').trim();
  const city = String(input.city || '').trim();
  const state = normalizeState(input.state);
  const full = stateFullName(state);
  const host = sosHostForState(state);
  const sites = ['site:opencorporates.com', 'site:bizapedia.com'];
  if (host) sites.push(`site:${host}`);
  return `${sites.join(' OR ')} "${company}" ${city} ${full || state} officer OR owner OR CEO OR president OR manager`.replace(
    /\s+/g,
    ' ',
  );
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
  // Address-style code ("Oakland, CA") — not the English word "in" / "or" / "me".
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
  // Score the company against each window of similar token length in the blob.
  const keyTokens = key.split(' ');
  const hayTokens = hay.split(' ');
  if (!hayTokens.length) return null;
  let best = 0;
  if (hay.includes(key) || key.includes(hay)) best = Math.max(best, 0.85);
  const window = Math.max(keyTokens.length, 2);
  for (let i = 0; i < hayTokens.length; i++) {
    const slice = hayTokens.slice(i, i + window + 1).join(' ');
    const tri = trigramSimilarity(company, slice);
    if (tri > best) best = tri;
  }
  const whole = trigramSimilarity(company, blob);
  if (whole > best) best = whole;
  if (best >= 0.48) return { method: 'trigram', score: best };
  return null;
}

function usablePersonName(name: string, company: string): boolean {
  const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 4 || cleaned.length > 80) return false;
  if (isRegistryAgentName(cleaned)) return false;
  if (hasCompanyWord(cleaned)) return false;
  if (namesMatchNormalized(cleaned, company)) return false;
  const tokens = cleaned.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;
  return /[A-Za-z]/.test(cleaned);
}

function extraSnippetEntries(text: string, company: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  const seen = new Set<string>();
  const push = (name: string, title: string) => {
    const cleaned = String(name || '').replace(/\s+/g, ' ').replace(/[,;]+$/g, '').trim();
    if (!usablePersonName(cleaned, company)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: cleaned, title: String(title || 'Officer').replace(/\s+/g, ' ').trim(), role: roleFromTitle(title) });
  };

  const isThe = new RegExp(
    `\\b([A-Z][A-Za-z.'\\-]+(?:\\s+[A-Z][A-Za-z.'\\-]+){1,3})\\s+is\\s+(?:the\\s+)?(${TITLE_BOUNDED})\\b`,
    'gi',
  );
  for (const m of text.matchAll(isThe)) push(m[1] || '', m[2] || 'Officer');

  const dash = new RegExp(
    `\\b([A-Z][A-Za-z.'\\-]+(?:\\s+[A-Z][A-Za-z.'\\-]+){1,3})\\s*[-–—]\\s*(${TITLE_BOUNDED})\\b`,
    'gi',
  );
  for (const m of text.matchAll(dash)) push(m[1] || '', m[2] || 'Officer');

  const titleFirst = new RegExp(
    `\\b(${TITLE_BOUNDED})\\s+([A-Z][A-Za-z.'\\-]+(?:\\s+[A-Z][A-Za-z.'\\-]+){1,3})\\b`,
    'gi',
  );
  for (const m of text.matchAll(titleFirst)) {
    if (isOfficerTitle(m[2] || '')) continue;
    push(m[2] || '', m[1] || 'Officer');
  }

  return out;
}

export function officersFromSerperBlob(blob: string, company: string): RosterEntry[] {
  const roster = parseOfficerRoster(blob).filter((row) => usablePersonName(row.name, company) && row.role !== 'registered_agent');
  const extra = extraSnippetEntries(blob, company);
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

export interface SerperCandidate {
  entry: RosterEntry;
  source_url: string;
  score: number;
  confidence: OwnerConfidence;
  company_method: 'exact' | 'substring' | 'trigram';
  trusted: boolean;
}

export function scoreSerperOrganic(
  input: NameLookupInput,
  hit: SerperOrganicHit,
): SerperCandidate | null {
  const url = String(hit.link || '').trim();
  const title = String(hit.title || '');
  const snippet = String(hit.snippet || '');
  const blob = `${title}\n${snippet}`;
  if (!url || isSkippedSerperHost(url)) return null;
  if (isChallengePage(blob) || isChallengePage(title) || isChallengePage(snippet)) return null;

  const companyHit = companyTiedToBlob(input.company_name, blob);
  if (!companyHit) return null;
  const cityOk = blobHasCity(blob, input.city);
  const stateOk = blobHasState(blob, input.state);
  if (!cityOk && !stateOk) return null;

  const officers = officersFromSerperBlob(blob, input.company_name);
  const entry = officers[0];
  if (!entry) return null;

  const trusted = isTrustedSerperHost(url, input.state);
  let score = 0;
  if (companyHit.method === 'exact') score += 0.4;
  else if (companyHit.method === 'substring') score += 0.3;
  else score += Math.min(0.22, companyHit.score * 0.3);
  if (cityOk) score += 0.15;
  if (stateOk) score += 0.15;
  if (trusted) score += 0.15;
  if (entry.title) score += 0.1;
  const split = splitPersonName(entry.name);
  if (split.first_name && split.last_name) score += 0.1;
  score = Math.min(1, Number(score.toFixed(3)));

  // Untrusted directories cannot be high — snippets are too noisy.
  if (!trusted && score >= SERPER_HIGH_SCORE) score = 0.79;
  // High requires city+state when the host is not official/OpenCorporates/Bizapedia.
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

  const before = ctxSerper(ctx).credits;
  const [generic, site] = await Promise.all([
    serperSearch(serperOfficerQuery(input), ctx),
    serperSearch(serperSiteQuery(input), ctx),
  ]);
  const credits = ctxSerper(ctx).credits - before;

  const organic: SerperOrganicHit[] = [
    ...organicFromSerperPayload(generic),
    ...organicFromSerperPayload(site),
  ];
  const kg = generic.knowledgeGraph?.description || site.knowledgeGraph?.description;
  if (kg && organic[0]) {
    organic[0] = {
      ...organic[0],
      snippet: `${organic[0].snippet || ''} ${kg}`.trim(),
    };
  }

  let best: SerperCandidate | null = null;
  for (const row of organic) {
    const cand = scoreSerperOrganic(input, row);
    if (!cand) continue;
    if (!best || cand.score > best.score || (cand.score === best.score && cand.trusted && !best.trusted)) {
      best = cand;
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
