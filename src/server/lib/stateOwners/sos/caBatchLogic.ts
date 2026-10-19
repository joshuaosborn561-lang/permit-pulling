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
  source_url?: string;
  document_id?: string;
  officers_text?: string;
  bytesBase64?: string;
  contentType?: string;
  agent_name?: string;
  error?: string;
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

export function caBatchNestedCity(row: Record<string, unknown>): { city: string | null; zip: string | null } {
  const addr =
    caBatchAsRecord(row.PRINCIPAL_ADDRESS) ||
    caBatchAsRecord(row.MAILING_ADDRESS) ||
    caBatchAsRecord(row.PHYSICAL_ADDRESS) ||
    caBatchAsRecord(row.ADDRESS);
  const city = addr ? caBatchPickString(addr, ['CITY', 'City', 'city']) : null;
  const zip = addr ? caBatchPickString(addr, ['POSTAL_CODE', 'ZIP', 'Zip', 'zip']) : null;
  return { city, zip };
}

export function caBatchNestedAgent(row: Record<string, unknown>): { name: string | null; city: string | null } {
  const agent = caBatchAsRecord(row.AGENT) || caBatchAsRecord(row.Agent);
  if (!agent) {
    return {
      name: caBatchPickString(row, ['AgentName', 'AGENT_NAME']),
      city: caBatchPickString(row, ['AgentCity', 'AGENT_CITY']),
    };
  }
  const name = caBatchPickString(agent, ['NAME', 'Name', 'FULL_NAME']);
  const addr = caBatchAsRecord(agent.ADDRESS) || caBatchAsRecord(agent.PHYSICAL_ADDRESS);
  const city = addr ? caBatchPickString(addr, ['CITY', 'City']) : caBatchPickString(agent, ['CITY', 'City']);
  return { name, city };
}

export function caBatchMapRow(raw: unknown): CaBatchEntity | null {
  const row = caBatchAsRecord(raw);
  if (!row) return null;
  const name = caBatchPickString(row, ['EntityName', 'ENTITY_NAME', 'TITLE', 'Name']);
  const id = caBatchPickString(row, ['EntityID', 'ENTITY_NUM', 'RECORD_NUM', 'RECORD_NUMBER', 'ID']);
  if (!name && !id) return null;
  const loc = caBatchNestedCity(row);
  const agent = caBatchNestedAgent(row);
  return {
    EntityID: id || undefined,
    EntityName: name || undefined,
    ForeignEntityName: caBatchPickString(row, ['ForeignEntityName', 'DBA', 'DBA_NAME']),
    EntityCity: caBatchPickString(row, ['EntityCity', 'CITY']) || loc.city,
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
  const key = caBatchNormalizeName(companyName);
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
        score = 80;
        method = 'substring';
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
        best = { entity, score, method };
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
    const filing = String(rec.FILING_TYPE || rec.FilingType || rec.filingType || rec.TYPE || rec.Type || '');
    const si = /statement of information|\bSI[- ]?550\b|\bLLC[- ]?12\b/i.test(filing);
    const date = String(rec.FILING_DATE || rec.FilingDate || rec.FILE_DATE || rec.EFFECTIVE_DATE || rec.DATE || rec.CREATED_DATE || '');
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
  const pool = siHits.length ? siHits : hits;
  if (!pool.length) return '';
  pool.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return pool[0].id;
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
