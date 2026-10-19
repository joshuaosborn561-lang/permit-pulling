import {
  hasCompanyWord,
  htmlToText,
  isPlaceName,
  isRegistryAgentName,
  parseBoardPersonName,
  splitPersonName,
  stripPersonHonorifics,
  validateOfficerPersonName,
} from '../names.js';
import type { BoardSource, OwnerConfidence, OwnerPerson, OwnerRole } from '../types.js';
import type { NameLookupInput, WaterfallOwnerHit } from './types.js';
import { ownerConfidenceFromMatch, waterfallHitFromPerson } from './waterfall.js';

export interface RosterEntry {
  name: string;
  title: string;
  role: OwnerRole;
  /** True when the name sat on a labeled officer/title row, not review prose. */
  labeled?: boolean;
}

const TITLE_ROLE: Array<{ re: RegExp; role: OwnerRole }> = [
  { re: /registered\s*agent|statutory\s*agent|agent\s+for\s+service/i, role: 'registered_agent' },
  { re: /\b(managing\s+member|member|manager)\b/i, role: 'member' },
  { re: /\b(sole\s+proprietor|owner)\b/i, role: 'owner' },
  { re: /\b(qualifying)\b/i, role: 'qualifying_individual' },
  { re: /\b./, role: 'officer' },
];

const TITLE =
  'Chief\\s+Executive\\s+Officer|Chief\\s+Financial\\s+Officer|Chief\\s+Operating\\s+Officer|' +
  'President|Vice\\s+President|Secretary|Treasurer|Directors?|Managers?|Managing\\s+Member|Member|' +
  'CEO|CFO|COO|VP|Governor|Partner|Principal|Owner|Founder|Organizer|Officer';

function caseInsensitiveTokenChars(raw: string): string {
  return raw.replace(/[A-Za-z]/g, (ch) => `[${ch.toUpperCase()}${ch.toLowerCase()}]`);
}

/** Title alts, case-insensitive without flipping the whole regex to /i/ (that would make [A-Z] eat lowercase). */
export const TITLE_CI = TITLE.split('|').map(caseInsensitiveTokenChars).join('|');
/** Word-bounded so "cookies" cannot match COO, "cooperation" cannot match COO, etc. */
export const TITLE_BOUNDED = `\\b(?:${TITLE_CI})\\b`;
const TITLE_RE = new RegExp(`^(?:${TITLE})$`, 'i');
const SKIP_NAME =
  /^(name|title|address|city|state|zip|none|n\/a|same|see below|continued|officer|director|manager|member|detail name|detail|entity name|business name|company name|legal name|officer name|full name)$/i;

const US_STATE_CODES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'
    .split(' ')
    .filter(Boolean),
);

const TITLE_STRIP_TOKENS = new Set(
  'president vice secretary treasurer director manager member ceo cfo coo vp governor partner principal owner founder organizer officer chief executive coach rev reverend dr doctor dvm md dds dmd esq jr sr ii iii iv phd prof professor ms mrs mr miss'
    .split(' '),
);

const FILLER_TOKENS = new Set(['and', 'the', 'of', 'for', 'llc', 'inc', 'ltd', 'corp', 'dba', 'co']);

const LABEL_TOKENS = new Set([
  'detail',
  'name',
  'title',
  'entity',
  'business',
  'company',
  'legal',
  'full',
  'address',
  'city',
  'state',
  'zip',
]);

const REVIEW_TOKENS = new Set(
  'was were is easy great good best love loved amazing highly recommend service always never just really awesome excellent friendly helpful professional process hiring them made'
    .split(' '),
);

/** One capitalized name token: Jane, JANE, O'Brien, Jean-Luc. Not "was". */
export const CAP_TOKEN = `[A-Z][A-Za-z'.\\-]{1,30}`;
/** Optional middle initial. */
const MID_TOKEN = `(?:${CAP_TOKEN}|[A-Z]\\.)`;
/**
 * Strict 2–3 capitalized tokens (First Last, First M. Last, LAST, FIRST).
 * Case-sensitive: lowercase review words cannot join the capture.
 */
export const CAP_NAME_CAPTURE =
  `(${CAP_TOKEN}\\s*,\\s*${MID_TOKEN}(?:\\s+${CAP_TOKEN})?|${CAP_TOKEN}\\s+${MID_TOKEN}(?:\\s+${CAP_TOKEN})?)`;

export function roleFromTitle(title: string): OwnerRole {
  for (const row of TITLE_ROLE) {
    if (row.re.test(title)) return row.role;
  }
  return 'officer';
}

export function isOfficerTitle(title: string): boolean {
  return TITLE_RE.test(String(title || '').trim());
}

function cleanName(raw: string): string {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/[,;]+$/g, '')
    .replace(/^\d+\.\s*/, '')
    .trim();
}

function keepNameToken(token: string): 'keep' | 'strip' | 'reject' {
  const letters = token.replace(/[^A-Za-z]/g, '');
  if (!letters) return 'strip';
  const upper = letters.toUpperCase();
  const lower = letters.toLowerCase();
  if (REVIEW_TOKENS.has(lower)) return 'reject';
  if (US_STATE_CODES.has(upper) && upper.length === 2) return 'strip';
  if (TITLE_STRIP_TOKENS.has(lower)) return 'strip';
  if (FILLER_TOKENS.has(lower)) return 'strip';
  if (LABEL_TOKENS.has(lower)) return 'strip';
  if (!/^[A-Z]/.test(token)) return 'reject';
  return 'keep';
}

/**
 * 2–3 capitalized person tokens. Strips state codes, title words, and labels.
 * Review-text names return null.
 */
export function scrubCapitalizedPersonName(raw: string): string | null {
  const cleaned = cleanName(stripPersonHonorifics(raw));
  if (!cleaned || cleaned.length > 80) return null;
  if (SKIP_NAME.test(cleaned)) return null;
  const comma = cleaned.includes(',');
  const tokens = cleaned.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const token of tokens) {
    const verdict = keepNameToken(token);
    if (verdict === 'reject') return null;
    if (verdict === 'strip') continue;
    kept.push(token.replace(/[,;]+$/g, ''));
  }
  if (kept.length < 2 || kept.length > 3) return null;
  const first = kept[0].replace(/[^A-Za-z]/g, '');
  const last = kept[kept.length - 1].replace(/[^A-Za-z]/g, '');
  if (first.length < 2 || last.length < 2) return null;
  if (kept.length === 3) {
    const mid = kept[1].replace(/[^A-Za-z]/g, '');
    if (!mid) return null;
  }
  if (comma && kept.length >= 2) return `${kept[0]}, ${kept.slice(1).join(' ')}`;
  return kept.join(' ');
}

function usablePersonName(name: string): boolean {
  const scrubbed = scrubCapitalizedPersonName(name);
  if (!scrubbed) return false;
  if (isRegistryAgentName(scrubbed)) return false;
  if (hasCompanyWord(scrubbed)) return false;
  if (isPlaceName(scrubbed)) return false;
  if (/^\d/.test(scrubbed)) return false;
  return validateOfficerPersonName(scrubbed).ok;
}

function pushEntry(
  out: RosterEntry[],
  seen: Set<string>,
  name: string,
  title: string,
  labeled = true,
): void {
  const cleaned = scrubCapitalizedPersonName(name);
  if (!cleaned || !usablePersonName(cleaned)) return;
  const role = roleFromTitle(title);
  if (role === 'registered_agent') return;
  const key = cleaned.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ name: cleaned, title: cleanName(title) || 'Officer', role, labeled });
}

/** SI-550 / LLC-12 / annual-report / HTML-table officer names. */
export function parseOfficerRoster(textOrHtml: string): RosterEntry[] {
  const raw = String(textOrHtml || '');
  if (!raw.trim()) return [];
  const text = /<[a-z][\s\S]*?>/i.test(raw) ? htmlToText(raw) : raw.replace(/\r/g, '');
  const out: RosterEntry[] = [];
  const seen = new Set<string>();

  const labeled = new RegExp(`${TITLE_BOUNDED}[ \\t]*[:\\-#]*[ \\t]*${CAP_NAME_CAPTURE}`, 'g');
  for (const hit of text.matchAll(labeled)) {
    const title = (hit[0] || '').split(/[:\-#]/)[0]?.trim() || 'Officer';
    pushEntry(out, seen, hit[1] || '', title, true);
  }

  const reversed = new RegExp(`${CAP_NAME_CAPTURE}\\s*,\\s*(${TITLE_BOUNDED})`, 'g');
  for (const hit of text.matchAll(reversed)) {
    pushEntry(out, seen, hit[1] || '', hit[2] || 'Officer', true);
  }

  const nameField = new RegExp(`\\bName[ \\t]*[:\\-]?[ \\t]*${CAP_NAME_CAPTURE}`, 'g');
  for (const hit of text.matchAll(nameField)) {
    pushEntry(out, seen, hit[1] || '', 'Officer', true);
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const titled = line.match(new RegExp(`^(${TITLE_BOUNDED})\\s*[:\\-]?\\s*${CAP_NAME_CAPTURE}$`));
    if (titled?.[1] && titled[2] && !isOfficerTitle(titled[2])) {
      pushEntry(out, seen, titled[2], titled[1], true);
      continue;
    }
    if (isOfficerTitle(line)) {
      let j = i + 1;
      let took = 0;
      const many = /directors?|managers?/i.test(line);
      while (j < lines.length) {
        const next = lines[j];
        if (isOfficerTitle(next)) break;
        const nextName = next.replace(/^(name|full name|detail name)\s*[:\-]\s*/i, '');
        if (!nextName) {
          j += 1;
          continue;
        }
        const before = out.length;
        pushEntry(out, seen, nextName, line, true);
        if (out.length === before) break;
        took += 1;
        j += 1;
        if (!many) break;
      }
      if (took) i = j - 1;
    }
  }

  if (/<[a-z][\s\S]*?>/i.test(raw)) {
    for (const row of raw.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        htmlToText(c[1] || '').replace(/\s+/g, ' ').trim(),
      );
      if (cells.length < 2) continue;
      const titleCell = cells.find((c) => isOfficerTitle(c));
      const nameCell = cells.find((c) => c !== titleCell && usablePersonName(c));
      if (titleCell && nameCell) pushEntry(out, seen, nameCell, titleCell);
    }
  }

  return out;
}

export function rosterToPeople(
  entries: RosterEntry[],
  source: BoardSource,
  sourceUrl: string,
  confidence: OwnerConfidence,
  extraPlaces: Array<string | null | undefined> = [],
): OwnerPerson[] {
  const people: OwnerPerson[] = [];
  const seen = new Set<string>();
  for (const row of entries) {
    if (row.role === 'registered_agent') continue;
    const verdict = validateOfficerPersonName(row.name, extraPlaces);
    if (verdict.reason === 'place' || verdict.reason === 'company' || verdict.reason === 'invalid') continue;
    const split = row.name.includes(',') ? parseBoardPersonName(row.name) : splitPersonName(row.name);
    const first = verdict.ok ? verdict.first_name : split.first_name;
    const last = verdict.ok ? verdict.last_name : split.last_name;
    const key = `${first || ''}|${last || ''}|${verdict.full_name || split.full_name_raw}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({
      first_name: first,
      last_name: last,
      full_name_raw: verdict.full_name || split.full_name_raw,
      role: row.role,
      source,
      source_url: sourceUrl,
      confidence,
      review_flag: verdict.ok ? split.review_flag || undefined : true,
    });
  }
  return people;
}

export function hitsFromRoster(
  input: NameLookupInput,
  entries: RosterEntry[],
  source: BoardSource,
  sourceUrl: string,
  matchMethod?: 'exact' | 'substring' | 'trigram' | 'license',
  opts?: { cityMatch?: boolean },
): WaterfallOwnerHit[] {
  let confidence = ownerConfidenceFromMatch(matchMethod);
  if (matchMethod === 'trigram' && opts?.cityMatch) confidence = 'medium';
  const people = rosterToPeople(entries, source, sourceUrl, confidence, [input.city]);
  return people.map((p) => {
    const hit = waterfallHitFromPerson(input, p, null);
    hit.match_method = matchMethod;
    hit.city_match = Boolean(opts?.cityMatch);
    if (p.role === 'member') hit.title = /managing/i.test(entries.find((e) => e.name === p.full_name_raw)?.title || '')
      ? 'Managing Member'
      : 'Member';
    else if (entries.find((e) => e.name === p.full_name_raw)?.title) {
      hit.title = entries.find((e) => e.name === p.full_name_raw)!.title;
    }
    return hit;
  });
}
