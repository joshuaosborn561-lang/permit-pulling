import { isRegistryAgentName, splitPersonName, validateOfficerPersonName } from '../names.js';
import type { BoardSource, CoverageReason, OwnerConfidence, OwnerPerson, OwnerRole } from '../types.js';
import type { NameLookupInput, WaterfallOwnerHit } from './types.js';

const ROLE_TITLE: Record<OwnerRole, string> = {
  owner: 'Owner',
  qualifying_individual: 'Qualifying Individual',
  officer: 'Officer',
  registered_agent: 'Registered Agent',
  member: 'Member',
  sole_proprietor: 'Sole Proprietor',
};

export function waterfallHitFromPerson(
  input: NameLookupInput,
  person: OwnerPerson,
  coverage: CoverageReason | null,
): WaterfallOwnerHit {
  return {
    first_name: person.first_name,
    last_name: person.last_name,
    title: ROLE_TITLE[person.role] || person.role,
    company_name: input.company_name,
    domain: input.domain ?? null,
    source_url: person.source_url,
    confidence: person.confidence,
    state: input.state,
    source: person.source,
    role: person.role,
    coverage_reason: coverage,
    review_flag: person.review_flag,
  };
}

export function agentOnlyHit(
  input: NameLookupInput,
  rawName: string,
  source: BoardSource,
  sourceUrl: string,
): WaterfallOwnerHit | null {
  const cleaned = String(rawName || '').replace(/\s+/g, ' ').trim();
  if (!cleaned || isRegistryAgentName(cleaned)) return null;
  const split = splitPersonName(cleaned);
  return {
    first_name: split.first_name,
    last_name: split.last_name,
    title: ROLE_TITLE.registered_agent,
    company_name: input.company_name,
    domain: input.domain ?? null,
    source_url: sourceUrl,
    confidence: 'low',
    state: input.state,
    source,
    role: 'registered_agent',
    coverage_reason: 'agent_only',
  };
}

export function isWaterfallReady(hit: WaterfallOwnerHit): boolean {
  if (hit.coverage_reason === 'agent_only' || hit.role === 'registered_agent') return false;
  if (
    hit.coverage_reason === 'blocked' ||
    hit.coverage_reason === 'not_found' ||
    hit.coverage_reason === 'no_source' ||
    hit.coverage_reason === 'not_implemented'
  ) {
    return false;
  }
  if (!hit.source_url) return false;
  if (hit.review_flag) return false;
  if (!hit.first_name || !hit.last_name) return false;
  if (!validateOfficerPersonName(`${hit.first_name} ${hit.last_name}`).ok) return false;
  if (hit.source === 'serper' && hit.confidence !== 'high') return false;
  if (hit.confidence === 'low') return false;
  if (hit.source === 'ca_bizfile' && hit.match_method === 'trigram' && hit.city_match !== true) {
    return false;
  }
  return true;
}

export function ownerConfidenceFromMatch(method: 'exact' | 'substring' | 'trigram' | 'license' | undefined): OwnerConfidence {
  if (method === 'trigram') return 'low';
  if (method === 'substring') return 'medium';
  return 'high';
}
