import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { normalizeState } from '../names.js';
import type { NameLookupInput, NameLookupResult } from './types.js';
import { isWaterfallReady } from './waterfall.js';

export interface SampleRow extends NameLookupInput {
  company: string;
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function csvEscape(value: string | number | boolean | null | undefined): string {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function readCompanyCsv(path: string): Promise<SampleRow[]> {
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  const rows: SampleRow[] = [];
  let headers: string[] | null = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    if (!headers) {
      headers = cells.map((h) => h.toLowerCase().replace(/\s+/g, '_'));
      continue;
    }
    const get = (...names: string[]) => {
      for (const n of names) {
        const idx = headers!.indexOf(n);
        if (idx >= 0 && cells[idx]) return cells[idx];
      }
      return '';
    };
    const company = get('company', 'company_name', 'name', 'business');
    const city = get('city');
    const state = normalizeState(get('state', 'st'));
    if (!company || !state) continue;
    rows.push({ company, company_name: company, city: city || null, state });
  }
  return rows;
}

export interface SampleResultLine {
  company: string;
  city: string;
  state: string;
  coverage_reason: string;
  source: string;
  match_method: string;
  implemented: boolean;
  officer_first: string;
  officer_last: string;
  officer_title: string;
  officer_count: number;
  waterfall_ready: boolean;
  agent_only: boolean;
  via_apify: boolean;
  via_serper: boolean;
  ocr_used: boolean;
  apify_usd: number;
  serper_credits: number;
  serper_usd: number;
  confidence: string;
  confidence_score: number;
  source_url: string;
}

export function resultToCsvRow(input: NameLookupInput, result: NameLookupResult): SampleResultLine {
  const officer = result.people.find((p) => isWaterfallReady(p));
  return {
    company: input.company_name,
    city: input.city || '',
    state: normalizeState(input.state),
    coverage_reason: result.coverage_reason || '',
    source: result.source,
    match_method: result.match_method || '',
    implemented: result.implemented,
    officer_first: officer?.first_name || '',
    officer_last: officer?.last_name || '',
    officer_title: officer?.title || '',
    officer_count: result.people.filter((p) => isWaterfallReady(p)).length,
    waterfall_ready: Boolean(officer),
    agent_only: result.coverage_reason === 'agent_only',
    via_apify: Boolean(result.via_apify),
    via_serper: Boolean(result.via_serper),
    ocr_used: Boolean(result.ocr_used),
    apify_usd: result.apify_usd || 0,
    serper_credits: result.serper_credits || 0,
    serper_usd: result.serper_usd || 0,
    confidence: officer?.confidence || '',
    confidence_score: officer?.confidence_score ?? 0,
    source_url: result.source_url || '',
  };
}

export const SAMPLE_CSV_HEADERS = [
  'company',
  'city',
  'state',
  'coverage_reason',
  'source',
  'match_method',
  'implemented',
  'officer_first',
  'officer_last',
  'officer_title',
  'officer_count',
  'waterfall_ready',
  'agent_only',
  'via_apify',
  'via_serper',
  'ocr_used',
  'apify_usd',
  'serper_credits',
  'serper_usd',
  'confidence',
  'confidence_score',
  'source_url',
] as const;

export function formatSampleCsv(rows: SampleResultLine[]): string {
  const lines = [SAMPLE_CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(SAMPLE_CSV_HEADERS.map((h) => csvEscape(row[h] as string | number | boolean)).join(','));
  }
  return lines.join('\n') + '\n';
}

export interface SampleSummary {
  rows: number;
  named: number;
  agent_only: number;
  not_found: number;
  missing_key: number;
  blocked: number;
  hit_rate: number;
  hit_rate_by_state: Record<string, { attempted: number; named: number; agent_only: number; hit_rate: number }>;
  officer_vs_agent: { officer: number; agent_only: number };
  apify_usd_spent: number;
  via_apify: number;
  serper_credits: number;
  serper_usd: number;
  via_serper: number;
  ocr_used: number;
}

export function summarizeSample(rows: SampleResultLine[]): SampleSummary {
  const hit_rate_by_state: SampleSummary['hit_rate_by_state'] = {};
  let named = 0;
  let agent_only = 0;
  let not_found = 0;
  let missing_key = 0;
  let blocked = 0;
  let apify = 0;
  let via = 0;
  let serperCredits = 0;
  let serperUsd = 0;
  let viaSerper = 0;
  let ocr = 0;
  for (const row of rows) {
    const st = row.state || 'UNK';
    const stats = hit_rate_by_state[st] || { attempted: 0, named: 0, agent_only: 0, hit_rate: 0 };
    stats.attempted += 1;
    if (row.waterfall_ready) {
      stats.named += 1;
      named += 1;
    }
    if (row.agent_only) {
      stats.agent_only += 1;
      agent_only += 1;
    }
    stats.hit_rate = stats.attempted ? Number((stats.named / stats.attempted).toFixed(3)) : 0;
    hit_rate_by_state[st] = stats;
    if (row.coverage_reason === 'not_found') not_found += 1;
    if (row.coverage_reason === 'missing_key') missing_key += 1;
    if (row.coverage_reason === 'blocked') blocked += 1;
    apify += row.apify_usd || 0;
    if (row.via_apify) via += 1;
    serperCredits += row.serper_credits || 0;
    serperUsd += row.serper_usd || 0;
    if (row.via_serper) viaSerper += 1;
    if (row.ocr_used) ocr += 1;
  }
  return {
    rows: rows.length,
    named,
    agent_only,
    not_found,
    missing_key,
    blocked,
    hit_rate: rows.length ? Number((named / rows.length).toFixed(3)) : 0,
    hit_rate_by_state,
    officer_vs_agent: { officer: named, agent_only },
    apify_usd_spent: Number(apify.toFixed(2)),
    via_apify: via,
    serper_credits: serperCredits,
    serper_usd: Number(serperUsd.toFixed(4)),
    via_serper: viaSerper,
    ocr_used: ocr,
  };
}
