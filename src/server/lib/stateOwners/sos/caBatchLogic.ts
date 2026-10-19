/**
 * Isomorphic CA batch helpers. No Node/DOM imports. Type annotations are
 * stripped by tsx/tsc so Function#toString() is valid Apify pageFunction JS.
 */

export const CA_BATCH_SEARCH_PATH = '/api/Records/businessSearch';
export const CA_BATCH_HISTORY_PATH = '/api/History/business/';
export const CA_BATCH_IMAGE_PATH = '/api/report/GetImageByNum/';
export const CA_BATCH_UI = 'https://bizfileonline.sos.ca.gov/search/business';
export const CA_BATCH_MIN_TRIGRAM = 0.48;
export const CA_BATCH_OCR_MIN_CHARS = 40;

export interface CaBatchEntity {
  EntityID?: string;
  EntityName?: string;
  ForeignEntityName?: string | null;
  EntityCity?: string | null;
  MailingCity?: string | null;
  AgentCity?: string | null;
  AgentName?: string | null;
  EntityZipCode?: string | null;
  MailingZipCode?: string | null;
}

export interface CaBatchPick {
  entity: CaBatchEntity;
  score: number;
  method: 'exact' | 'substring' | 'trigram';
  city_match: boolean;
}

export interface CaBatchCompany {
  company_name: string;
  city?: string | null;
  state?: string;
}

export interface CaBatchDatasetItem {
  company_name: string;
  city: string;
  state: string;
  status: 'ok' | 'not_found' | 'blocked' | 'error';
  retries: number;
  entity_id?: string;
  business_name?: string;
  match_method?: 'exact' | 'substring' | 'trigram';
  match_score?: number;
  city_match?: boolean;
  source_url?: string;
  document_id?: string;
  officers_text?: string;
  bytesBase64?: string;
  contentType?: string;
  agent_name?: string;
  error?: string;
  debug_steps?: Array<{ step: string; status?: number; error?: string; errorCode?: number; bytes?: number }>;
}

export function caBatchCompanyKey(companyName: string, city: string | null | undefined): string {
  return `${String(companyName || '').trim().toUpperCase()}|${String(city || '').trim().toUpperCase()}`;
}

export function caBatchIsChallenge(body: string): boolean {
  const text = String(body || '');
  if (!text.trim()) return false;
  if (/just a moment/i.test(text)) return true;
  if (/enable javascript and cookies/i.test(text)) return true;
  if (/cf-mitigation|cf-browser-verification|challenge-platform|cdn-cgi\/challenge-platform/i.test(text)) return true;
  if (/checking your browser before accessing|attention required|managed challenge/i.test(text)) return true;
  if (/_Incapsula_Resource/i.test(text) && text.length < 4000) return true;
  if (/incapsula|imperva|request unsuccessful|incident id/i.test(text) && /<META NAME="robots"/i.test(text) && text.length < 4000) {
    return true;
  }
  return false;
}

/** Incapsula 429 / errorCode 15 — never treat as a company miss. */
export function caBatchIsWafBlock(status: number | string | null | undefined, body: string): boolean {
  const code = Number(status);
  if (code === 429 || code === 403 || code === 401) return true;
  const text = String(body || '');
  if (!text.trim()) return false;
  if (caBatchIsChallenge(text)) return true;
  if (/this request was blocked by our security service/i.test(text)) return true;
  if (/\bwaf_429\b/i.test(text)) return true;
  if (/errorCode["']?\s*[:=]\s*"?15\b/i.test(text)) return true;
  if (/\bstatus["']?\s*[:=]\s*429\b/i.test(text)) return true;
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const err = parsed.errorCode || parsed.error_code || parsed.ErrorCode || parsed.code;
      if (Number(err) === 15) return true;
    }
  } catch {
    /* not json */
  }
  return false;
}

export function caBatchNormalizeName(name: string): string {
  return String(name || '')
    .toUpperCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\bD\s*\.?\s*B\s*\.?\s*A\.?\s+.+$/i, ' ')
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b(THE|A|AN|LLC|L\s*L\s*C|INC|INCORPORATED|LTD|LP|LLP|PLLC|PC|PA|CO|COMPANY|CORP|CORPORATION)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop DBA / dash-pipe marketing / Division / Dr…DVM before SOS search. Keep isomorphic (no names.ts). */
export function caBatchCoreSearchName(name: string): string {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\bD\s*\.?\s*B\s*\.?\s*A\.?\s+.+$/i, ' ').trim();
  s = s.split(/\s*[|–—]\s*/)[0] || s;
  s = s.split(/\s+-\s+/)[0] || s;
  s = s.replace(/\bdivisions?\b.*$/i, ' ').trim();
  s = s.replace(/\s+\bdr\.?\s+.+$/i, ' ').trim();
  s = s.replace(/\s+\bdvm\b.*$/i, ' ').trim();
  s = s
    .replace(
      /\b(a veterinary practice|animal hospital|pet hospital|veterinary clinic|dental practice|family dentistry|wealth management|orthodontics)\b.*$/i,
      ' ',
    )
    .trim();
  return s.replace(/\s+/g, ' ').trim().slice(0, 49);
}

export function caBatchTrigram(a: string, b: string): number {
  const left = caBatchNormalizeName(a);
  const right = caBatchNormalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (s: string): string[] => {
    const padded = `  ${s} `;
    const out: string[] = [];
    for (let i = 0; i <= padded.length - 3; i += 1) out.push(padded.slice(i, i + 3));
    return out;
  };
  const ga = grams(left);
  const gb = grams(right);
  const counts = new Map();
  for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);
  let inter = 0;
  for (const g of gb) {
    const n = counts.get(g) || 0;
    if (n > 0) {
      inter += 1;
      counts.set(g, n - 1);
    }
  }
  return (2 * inter) / (ga.length + gb.length);
}

export function caBatchPickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
  }
  return null;
}

export function caBatchAsRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** City/ZIP from a US address string ("548 MARKET ST, SAN FRANCISCO, CA 94104") or nested object. */
export function caBatchCityZipFromAddress(value: unknown): { city: string | null; zip: string | null } {
  if (typeof value === 'string') {
    const compact = value.replace(/\s+/g, ' ').trim();
    const m = compact.match(/,\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})(?:-\d{4})?\s*$/i);
    if (m) return { city: m[1].trim(), zip: m[3] };
    return { city: null, zip: null };
  }
  const rec = caBatchAsRecord(value);
  if (!rec) return { city: null, zip: null };
  return {
    city: caBatchPickString(rec, ['CITY', 'City', 'city']),
    zip: caBatchPickString(rec, ['POSTAL_CODE', 'ZIP', 'Zip', 'zip', 'postalCode']),
  };
}

export function caBatchNestedCity(row: Record<string, unknown>): { city: string | null; zip: string | null } {
  const blobs = [
    row.PRINCIPAL_ADDRESS,
    row.MAILING_ADDRESS,
    row.PHYSICAL_ADDRESS,
    row.ADDRESS,
    row.principalAddress,
    row.mailingAddress,
    row.physicalAddress,
    row.address,
  ];
  for (const blob of blobs) {
    const got = caBatchCityZipFromAddress(blob);
    if (got.city || got.zip) return got;
  }
  return { city: null, zip: null };
}

export function caBatchNestedAgent(row: Record<string, unknown>): { name: string | null; city: string | null } {
  const agent = caBatchAsRecord(row.AGENT) || caBatchAsRecord(row.Agent);
  if (!agent) {
    return {
      name: caBatchPickString(row, ['AgentName', 'AGENT_NAME', 'agentName']),
      city: caBatchPickString(row, ['AgentCity', 'AGENT_CITY', 'agentCity']),
    };
  }
  const name = caBatchPickString(agent, ['NAME', 'Name', 'FULL_NAME', 'name']);
  const addr = caBatchAsRecord(agent.ADDRESS) || caBatchAsRecord(agent.PHYSICAL_ADDRESS);
  const city = addr ? caBatchPickString(addr, ['CITY', 'City', 'city']) : caBatchPickString(agent, ['CITY', 'City', 'city']);
  return { name, city };
}

export function caBatchMapRow(raw: unknown): CaBatchEntity | null {
  const row = caBatchAsRecord(raw);
  if (!row) return null;
  const name = caBatchPickString(row, ['EntityName', 'ENTITY_NAME', 'TITLE', 'Name', 'name', 'entityName']);
  const id = caBatchPickString(row, [
    'EntityID',
    'ENTITY_NUM',
    'RECORD_NUM',
    'RECORD_NUMBER',
    'ID',
    'entityNumber',
    'entity_number',
    'recordNumber',
  ]);
  if (!name && !id) return null;
  const loc = caBatchNestedCity(row);
  const agent = caBatchNestedAgent(row);
  return {
    EntityID: id || undefined,
    EntityName: name || undefined,
    ForeignEntityName: caBatchPickString(row, ['ForeignEntityName', 'DBA', 'DBA_NAME']),
    EntityCity: caBatchPickString(row, ['EntityCity', 'CITY', 'city']) || loc.city,
    MailingCity: caBatchPickString(row, ['MailingCity']) || loc.city,
    AgentCity: agent.city,
    AgentName: agent.name,
    MailingZipCode: caBatchPickString(row, ['MailingZipCode']) || loc.zip,
    EntityZipCode: caBatchPickString(row, ['EntityZipCode', 'ZIP']) || loc.zip,
  };
}

export function caBatchRowsFromPayload(payload: unknown): CaBatchEntity[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.map(caBatchMapRow).filter((r): r is CaBatchEntity => Boolean(r));
  const row = caBatchAsRecord(payload);
  if (!row) return [];
  const lists = [row.EntityData, row.rows, row.ROWS];
  const data = caBatchAsRecord(row.data);
  if (data) lists.push(data.rows, data.EntityData);
  for (const list of lists) {
    if (Array.isArray(list) && list.length) {
      return list.map(caBatchMapRow).filter((r): r is CaBatchEntity => Boolean(r));
    }
  }
  return [];
}

export function caBatchEntityCity(row: CaBatchEntity): string {
  return String(row.EntityCity || row.MailingCity || row.AgentCity || '').trim();
}

export function caBatchSplitDba(name: string): string[] {
  const raw = String(name || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const labels = [raw];
  const m = raw.match(/^(.*?)\s+\bD\s*\.?\s*B\s*\.?\s*A\.?\s+(.+)$/i);
  if (m && m[1] && m[2]) {
    labels.push(m[1].trim(), m[2].trim());
  }
  return labels;
}

export function caBatchPickEntity(
  companyName: string,
  city: string | null | undefined,
  rows: CaBatchEntity[],
): CaBatchPick | null {
  const key = caBatchNormalizeName(caBatchCoreSearchName(companyName) || companyName);
  if (!key || !rows || !rows.length) return null;
  const wantCity = String(city || '').trim().toLowerCase();
  let best: CaBatchPick | null = null;
  let second = 0;
  for (const entity of rows) {
    const labels = caBatchSplitDba(entity.EntityName || '');
    if (entity.ForeignEntityName) labels.push(entity.ForeignEntityName);
    for (const label of labels) {
      const hit = caBatchNormalizeName(label);
      if (!hit) continue;
      let score = 0;
      let method: CaBatchPick['method'] = 'trigram';
      if (hit === key) {
        score = 100;
        method = 'exact';
      } else if (hit.includes(key) || key.includes(hit)) {
        const shorter = key.length <= hit.length ? key : hit;
        const tokenCount = shorter.split(' ').filter(Boolean).length;
        const itemCity = caBatchEntityCity(entity).toLowerCase();
        const cityOk = Boolean(wantCity && itemCity && itemCity === wantCity);
        if (tokenCount >= 2 || cityOk) {
          score = 80;
          method = 'substring';
        }
      } else {
        const tri = caBatchTrigram(key, hit);
        if (tri >= CA_BATCH_MIN_TRIGRAM) {
          score = Math.round(tri * 100);
          method = 'trigram';
        }
      }
      if (score > 0 && wantCity) {
        const itemCity = caBatchEntityCity(entity).toLowerCase();
        if (itemCity && itemCity === wantCity) score += 8;
      }
      if (score > (best?.score || 0)) {
        second = best?.score || 0;
        const itemCity = caBatchEntityCity(entity).toLowerCase();
        best = {
          entity,
          score,
          method,
          city_match: Boolean(wantCity && itemCity && itemCity === wantCity),
        };
      } else if (score > second) {
        second = score;
      }
    }
  }
  if (!best) return null;
  if (best.method === 'trigram' && best.score < Math.round(CA_BATCH_MIN_TRIGRAM * 100)) return null;
  if (best.method === 'trigram' && second > 0 && best.score - second < 5) return null;
  if (best.method !== 'trigram' && best.score < 70) return null;
  return best;
}

export function caBatchSearchBody(searchTerm: string): Record<string, unknown> {
  return {
    SEARCH_VALUE: String(searchTerm || '').trim(),
    SEARCH_FILTER_TYPE_ID: 'search',
    STATUS_ID: '',
    FILING_TYPE_ID: '',
    RECORD_TYPE_ID: '',
    FILING_DATE: { start: null, end: null },
  };
}

export function caBatchParseJson(raw: string): unknown {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[\[{]/);
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

export function caBatchLatestSiDocumentId(payload: unknown): string {
  const hits: Array<{ id: string; date: string; si: boolean }> = [];
  const seen = new Set();
  const walk = (node: unknown): void => {
    if (!node) return;
    if (typeof node === 'string') {
      const m = node.match(/GetImageByNum\/([0-9]{12,})/);
      if (m && m[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        hits.push({ id: m[1], date: '', si: false });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = caBatchAsRecord(node);
    if (!rec) return;
    const filing = String(
      rec.FILING_TYPE || rec.FilingType || rec.filingType || rec.TYPE || rec.Type || rec.type || rec.title || '',
    );
    const si = /statement of information|\bSI[- ]?550\b|\bLLC[- ]?12\b/i.test(filing);
    const date = String(
      rec.FILING_DATE ||
        rec.FilingDate ||
        rec.FILE_DATE ||
        rec.EFFECTIVE_DATE ||
        rec.DATE ||
        rec.CREATED_DATE ||
        rec.date ||
        rec.effectiveDate ||
        '',
    );
    const href = String(rec.documentUrl || rec.document_url || rec.url || rec.href || rec.pdfUrl || rec.fileUrl || '');
    const fromHref = href.match(/GetImageByNum\/([0-9]{12,})/i);
    if (fromHref?.[1] && !seen.has(fromHref[1])) {
      seen.add(fromHref[1]);
      hits.push({ id: fromHref[1], date, si });
    } else if (fromHref?.[1] && si) {
      for (const hit of hits) {
        if (hit.id === fromHref[1]) hit.si = true;
      }
    }
    const keys = ['DOCUMENT_ID', 'DocumentId', 'documentId', 'IMAGE_NUM', 'ImageNum', 'imageNum', 'IMAGE_ID'];
    for (const key of keys) {
      const v = rec[key];
      let id = '';
      if (typeof v === 'string' && v.trim()) id = v.trim();
      else if (typeof v === 'number' && Number.isFinite(v)) id = String(v);
      if (id && !seen.has(id)) {
        seen.add(id);
        hits.push({ id, date, si });
      } else if (id && si) {
        for (const hit of hits) {
          if (hit.id === id) hit.si = true;
        }
      }
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(payload);
  const siHits = hits.filter((h) => h.si);
  if (!siHits.length) return '';
  const ts = (d: string): number => {
    const n = Date.parse(d);
    return Number.isFinite(n) ? n : 0;
  };
  siHits.sort((a, b) => ts(b.date) - ts(a.date) || String(b.date).localeCompare(String(a.date)));
  return siHits[0].id;
}

export function caBatchUnescapePdf(raw: string): string {
  return String(raw || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\(\d{1,3})/g, (_m, n: string) => String.fromCharCode(parseInt(n, 8)));
}

export function caBatchExtractPdfText(latin1: string): string {
  const ascii = String(latin1 || '');
  if (ascii.indexOf('%PDF') !== 0) {
    if (/CEO|CFO|Secretary|Director|Manager|Chief Executive|Chief Financial/i.test(ascii) && !caBatchIsChallenge(ascii)) {
      return ascii;
    }
    return '';
  }
  const chunks: string[] = [];
  const re = /\((?:\\.|[^\\)]){2,200}\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ascii))) {
    const inner = caBatchUnescapePdf(m[0].slice(1, -1));
    if (/[A-Za-z]{3,}/.test(inner)) chunks.push(inner);
  }
  return chunks.join('\n').replace(/[ \t]+/g, ' ').trim();
}

export function caBatchTextNeedsOcr(text: string): boolean {
  const letters = String(text || '').replace(/[^A-Za-z]/g, '');
  return letters.length < CA_BATCH_OCR_MIN_CHARS;
}

export function caBatchSourceUrl(entityId: string | null | undefined): string {
  const id = String(entityId || '').trim();
  if (!id) return CA_BATCH_UI;
  return `${CA_BATCH_UI}/${encodeURIComponent(id)}`;
}
