import { getSetting, loadAppSettings } from './appSettings.js';

export const VERIPHONE_USD_PER_LOOKUP = 0.024; // mode=current = 10 credits per lookup

/** 10-digit NANP (optional leading 1). Empty / extensions-only / junk → null. */
export function nanpDigits(phone: string): string | null {
  let d = (phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return null;
  if (d[0] === '0' || d[0] === '1') return null;
  return d;
}

export function hasVeriphone(): boolean {
  return Boolean(getSetting('veriphone_api_key'));
}

export interface VeriphoneLookup {
  phone: string;
  e164: string | null;
  valid: boolean;
  phone_type: string;
  normalized_type: 'mobile' | 'landline' | 'voip' | 'toll_free' | 'unknown' | 'invalid';
  carrier: string | null;
  country: string | null;
  raw_status: string | null;
}

function normalizeType(raw: string): VeriphoneLookup['normalized_type'] {
  const t = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (t.includes('mobile') || t.includes('wireless') || t === 'cell') return 'mobile';
  if (t.includes('voip')) return 'voip';
  if (t.includes('toll')) return 'toll_free';
  if (t.includes('land') || t.includes('fixed') || t.includes('wireline')) return 'landline';
  return 'unknown';
}

export async function lookupVeriphone(phone: string): Promise<VeriphoneLookup> {
  await loadAppSettings();
  const key = getSetting('veriphone_api_key');
  if (!key) throw new Error('VERIPHONE_API_KEY is not set — Cayden can paste it with set_enrichment_api_key');
  const digits = phone.replace(/\D/g, '');
  const url = new URL('https://api.veriphone.io/v2/verify');
  url.searchParams.set('key', key);
  url.searchParams.set('phone', digits.length === 10 ? `+1${digits}` : phone);
  // Live porting-registry line type (10 credits/lookup).
  url.searchParams.set('mode', 'current');
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = (await res.json().catch(() => null)) as {
    status?: string;
    phone?: string;
    phone_valid?: boolean;
    phone_type?: string;
    carrier?: string;
    country?: string;
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(`Veriphone ${res.status}: ${body?.error || res.statusText}`);
  }
  const rawType = String(body?.phone_type || '');
  const normalized: VeriphoneLookup['normalized_type'] =
    body?.phone_valid === false && !rawType ? 'invalid' : normalizeType(rawType);
  return {
    phone,
    e164: body?.phone ?? null,
    valid: Boolean(body?.phone_valid),
    phone_type: rawType || 'unknown',
    normalized_type: normalized,
    carrier: body?.carrier ?? null,
    country: body?.country ?? null,
    raw_status: body?.status ?? null,
  };
}

export function estimateVeriphoneUsd(n: number): { lookups: number; usd: number; note: string } {
  return {
    lookups: n,
    usd: Math.round(n * VERIPHONE_USD_PER_LOOKUP * 100) / 100,
    note: 'Veriphone mode=current (live porting registry) = 10 credits/lookup, ~$24 per 1,000 at Standard list price. Confirm before running lookup_line_type.',
  };
}
