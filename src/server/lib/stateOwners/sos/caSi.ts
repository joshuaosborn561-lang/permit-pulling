import { DESKTOP_UA, isChallengePage, looksBlocked } from '../http.js';
import type { LookupContext } from './context.js';
import { ctxFetch } from './context.js';
import { apifyFetchHtml } from './apifyPlaywright.js';
import { textFromDocument } from './ocr.js';
import {
  CAP_NAME_CAPTURE,
  isOfficerTitle,
  parseOfficerRoster,
  scrubCapitalizedPersonName,
  type RosterEntry,
} from './officers.js';
import { CA_BIZFILE_ONLINE_SEARCH, CA_BIZFILE_ONLINE_UI, type CaBizfileEntity } from './caBizfile.js';

export { CA_BIZFILE_ONLINE_SEARCH, CA_BIZFILE_ONLINE_UI };

/** Verified from public bizfileOnline / indexed filings. Path param is document id, not file number. */
export const CA_SI_IMAGE_BASE = 'https://bizfileonline.sos.ca.gov/api/report/GetImageByNum';

export function caSiImageUrl(documentId: string): string {
  const id = String(documentId || '').trim().replace(/^\/+/, '');
  return `${CA_SI_IMAGE_BASE}/${encodeURIComponent(id)}`;
}

/** @deprecated invented query-string URLs — use caSiImageUrl(documentId). */
export function caSiImageUrls(entityOrDocumentId: string): string[] {
  return [caSiImageUrl(entityOrDocumentId)];
}

export function caSiHistoryUrls(entityId: string): string[] {
  const id = encodeURIComponent(entityId.trim());
  return [
    `https://bizfileonline.sos.ca.gov/api/History/business/${id}`,
    `https://bizfileonline.sos.ca.gov/api/FilingDetail/business/${id}`,
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function splitOfficerTitleLine(line: string): string[] {
  const parts = String(line || '')
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  if (parts.every((part) => isOfficerTitle(part))) return parts;
  return [];
}

/**
 * Live bizfileOnline SI PDFs (web-fetch text) look like:
 *   Officer Name <tab> Officer Address <tab> Position(s)
 *   • JANE SAMPLE <tab> 100 MAIN ST.
 *   OAKLAND, CA 94612
 *   Chief Executive Officer, Chief Financial Officer, Secretary
 * Rewrite that into the labeled TITLE\\nNAME shape parseOfficerRoster already handles.
 */
export function normalizeCaSosSiPdf(text: string): string {
  const raw = String(text || '');
  if (!/Officer Name/i.test(raw) && !/Position\(s\)/i.test(raw) && !/Director Name/i.test(raw)) {
    return raw;
  }
  const lines = raw
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const emitted: string[] = [];
  let section: 'officer' | 'director' | 'manager' | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^additional officers$/i.test(line) || (/officer name/i.test(line) && /position/i.test(line))) {
      section = 'officer';
      continue;
    }
    if (/^officers$/i.test(line)) {
      section = 'officer';
      continue;
    }
    if (/^directors$/i.test(line) || /director name/i.test(line)) {
      section = 'director';
      continue;
    }
    if (/^managers$/i.test(line) || /manager name/i.test(line)) {
      section = 'manager';
      continue;
    }
    if (/agent for service|type of business|electronic signature|labor judgment/i.test(line)) {
      section = null;
      continue;
    }
    if (!section) continue;
    if (/vacancies|none entered/i.test(line)) continue;
    if (splitOfficerTitleLine(line).length) continue;

    const stripped = line.replace(/^[+•*\-]+\s*/, '');
    // Address-only city lines ("SAN DIEGO, CA 92105") are not officers; person rows use a tab.
    if (!/\t/.test(stripped) && /,\s*[A-Z]{2}\s*\d{5}/i.test(stripped)) continue;
    const nameHit = stripped.match(new RegExp(`^${CAP_NAME_CAPTURE}`));
    const nameRaw = (nameHit?.[1] || stripped.split(/\t|\s{2,}/)[0] || '').trim();
    if (!nameRaw || /\d/.test(nameRaw)) continue;
    if (isOfficerTitle(nameRaw)) continue;
    if (!scrubCapitalizedPersonName(nameRaw)) continue;

    let titles: string[] =
      section === 'director' ? ['Directors'] : section === 'manager' ? ['Managers'] : [];
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
      const parts = splitOfficerTitleLine(lines[j]);
      if (parts.length) {
        titles = parts;
        break;
      }
      const nxtName = lines[j].replace(/^[+•*\-]+\s*/, '').split(/\t/)[0].trim();
      if (scrubCapitalizedPersonName(nxtName) && !/\d/.test(nxtName)) break;
    }
    if (!titles.length) continue;
    for (const title of titles) {
      emitted.push(title);
      emitted.push(nameRaw);
    }
  }
  return emitted.length ? emitted.join('\n') : raw;
}

/**
 * SI-550 / LLC-12 officer table (CEO, CFO, Secretary, Directors, Managers).
 * Challenge HTML is never parsed. Host-side; pageFunction only extracts text.
 */
export function parseSiOfficerTable(text: string): RosterEntry[] {
  const raw = String(text || '');
  if (!raw.trim() || isChallengePage(raw)) return [];
  return parseOfficerRoster(normalizeCaSosSiPdf(raw));
}

export function documentIdsFromPayload(payload: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown) => {
    if (!node) return;
    if (typeof node === 'string') {
      const m = node.match(/GetImageByNum\/([0-9]{12,})/);
      if (m?.[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        ids.push(m[1]);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = asRecord(node);
    if (!rec) return;
    for (const key of ['DOCUMENT_ID', 'DocumentId', 'documentId', 'IMAGE_NUM', 'ImageNum', 'imageNum', 'IMAGE_ID']) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim() && !seen.has(v.trim())) {
        seen.add(v.trim());
        ids.push(v.trim());
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        const s = String(v);
        if (!seen.has(s)) {
          seen.add(s);
          ids.push(s);
        }
      }
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(payload);
  return ids;
}

function officersFromUnknown(payload: unknown): RosterEntry[] {
  if (!payload) return [];
  if (typeof payload === 'string') {
    if (isChallengePage(payload)) return [];
    return parseOfficerRoster(payload);
  }
  const blob = JSON.stringify(payload);
  const fromText = parseOfficerRoster(blob);
  if (fromText.length) return fromText;
  const rows: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    const name = rec.Name || rec.name || rec.OfficerName || rec.officerName || rec.fullName || rec.FullName;
    const title = rec.Title || rec.title || rec.OfficerTitle || rec.Position || rec.position;
    if (typeof name === 'string' && name.trim()) {
      rows.push(`${title || 'Officer'}: ${name}`);
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(payload);
  return rows.length ? parseOfficerRoster(rows.join('\n')) : [];
}

async function fetchBytes(
  url: string,
  ctx: LookupContext | undefined,
  init?: RequestInit,
): Promise<{ status: number; bytes: Uint8Array; contentType: string; blocked: boolean; url: string }> {
  const res = await ctxFetch(ctx)(url, {
    redirect: 'follow',
    ...init,
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json,application/pdf,image/*,text/html;q=0.8,*/*;q=0.5',
      Origin: 'https://bizfileonline.sos.ca.gov',
      Referer: `${CA_BIZFILE_ONLINE_UI}/`,
      ...(init?.headers || {}),
    },
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || '';
  const preview = Buffer.from(bytes.slice(0, 800)).toString('utf8');
  const blocked =
    looksBlocked(res.status, preview) || isChallengePage(preview) || res.status === 403 || res.status === 401;
  return { status: res.status, bytes, contentType, blocked, url: res.url || url };
}

export interface CaSiFetchResult {
  entries: RosterEntry[];
  text: string;
  source_url: string;
  via_apify: boolean;
  ocr_used: boolean;
  usd: number;
}

async function parseDocumentBytes(
  bytes: Uint8Array,
  contentType: string,
  sourceUrl: string,
  ctx: LookupContext | undefined,
): Promise<CaSiFetchResult | null> {
  const preview = Buffer.from(bytes.slice(0, 800)).toString('utf8');
  if (isChallengePage(preview)) return null;
  if (preview.trim().startsWith('{') || preview.trim().startsWith('[')) {
    try {
      const payload = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const entries = officersFromUnknown(payload);
      if (entries.length) {
        return { entries, text: '', source_url: sourceUrl, via_apify: false, ocr_used: false, usd: 0 };
      }
    } catch {
      /* not json */
    }
  }
  const doc = await textFromDocument(bytes, contentType, ctx);
  if (isChallengePage(doc.text)) return null;
  const entries = parseOfficerRoster(doc.text);
  if (entries.length) {
    return { entries, text: doc.text, source_url: sourceUrl, via_apify: false, ocr_used: doc.ocr_used, usd: 0 };
  }
  return null;
}

/**
 * Statement of Information officers. Direct image/JSON first, Apify Playwright
 * only if the official host blocks, OCR for PDF/image SI (tesseract.js).
 */
export async function fetchCaStatementOfficers(
  entity: CaBizfileEntity,
  ctx?: LookupContext,
): Promise<CaSiFetchResult> {
  const entityId = String(entity.EntityID || '').trim();
  const empty: CaSiFetchResult = {
    entries: [],
    text: '',
    source_url: CA_BIZFILE_ONLINE_UI,
    via_apify: false,
    ocr_used: false,
    usd: 0,
  };
  if (ctx?.caSiText != null) {
    if (isChallengePage(ctx.caSiText)) return empty;
    return {
      ...empty,
      entries: parseOfficerRoster(ctx.caSiText),
      text: ctx.caSiText,
      source_url: `https://bizfileonline.sos.ca.gov/search/business/${entityId}`,
    };
  }
  if (ctx?.caSiBytes) {
    const parsed = await parseDocumentBytes(ctx.caSiBytes, 'application/octet-stream', empty.source_url, ctx);
    return parsed || empty;
  }
  if (!entityId || !ctx?.live) return empty;

  const documentIds: string[] = [];
  try {
    const searchRes = await fetchBytes(CA_BIZFILE_ONLINE_SEARCH, ctx, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        SEARCH_VALUE: entityId,
        SEARCH_FILTER_TYPE_ID: 'fileNumber',
        STATUS_ID: '',
        FILING_TYPE_ID: '',
        RECORD_TYPE_ID: '',
      }),
    });
    if (!searchRes.blocked) {
      const parsed = await parseDocumentBytes(searchRes.bytes, searchRes.contentType, CA_BIZFILE_ONLINE_SEARCH, ctx);
      if (parsed) return parsed;
      try {
        const payload = JSON.parse(Buffer.from(searchRes.bytes).toString('utf8'));
        documentIds.push(...documentIdsFromPayload(payload));
      } catch {
        /* continue */
      }
    }
  } catch {
    /* try history / images */
  }

  for (const url of caSiHistoryUrls(entityId)) {
    try {
      const got = await fetchBytes(url, ctx);
      if (got.blocked || got.status >= 400) continue;
      const parsed = await parseDocumentBytes(got.bytes, got.contentType, url, ctx);
      if (parsed) return parsed;
      try {
        documentIds.push(...documentIdsFromPayload(JSON.parse(Buffer.from(got.bytes).toString('utf8'))));
      } catch {
        /* continue */
      }
    } catch {
      continue;
    }
  }

  const uniqueIds = [...new Set(documentIds)];
  for (const docId of uniqueIds) {
    const url = caSiImageUrl(docId);
    try {
      const got = await fetchBytes(url, ctx);
      if (got.blocked || got.status >= 400) continue;
      const parsed = await parseDocumentBytes(got.bytes, got.contentType, url, ctx);
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }

  if (ctx.apifyEnabled === false) return empty;
  const imageUrl = uniqueIds.length ? caSiImageUrl(uniqueIds[0]) : `${CA_BIZFILE_ONLINE_UI}/${encodeURIComponent(entityId)}`;
  const apify = await apifyFetchHtml(imageUrl, ctx, { documentBytes: true, immediate: true });
  if (apify.refused) return { ...empty, via_apify: false, usd: 0 };
  if (apify.bytes && apify.bytes.length) {
    const parsed = await parseDocumentBytes(apify.bytes, apify.contentType || 'application/octet-stream', imageUrl, ctx);
    if (parsed) return { ...parsed, via_apify: true, usd: apify.usd };
  }
  const html = apify.html || apify.text;
  if (html && !isChallengePage(html) && !looksBlocked(200, html)) {
    const entries = parseOfficerRoster(html);
    if (entries.length) {
      return {
        entries,
        text: html,
        source_url: imageUrl,
        via_apify: true,
        ocr_used: false,
        usd: apify.usd,
      };
    }
    const parsed = await parseDocumentBytes(Buffer.from(html), 'text/html', imageUrl, ctx);
    if (parsed) return { ...parsed, via_apify: true, usd: apify.usd };
  }
  return { ...empty, via_apify: true, usd: apify.usd };
}
