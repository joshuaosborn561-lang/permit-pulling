import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { caSiImageUrl, caSiImageUrls, documentIdsFromPayload, fetchCaStatementOfficers, parseSiOfficerTable } from './caSi.js';
import { parseOfficerRoster } from './officers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('CA Statement of Information endpoints', () => {
  it('uses /api/report/GetImageByNum/{documentId} not invented query strings', () => {
    const url = caSiImageUrl('081253081046137249104234083090073041121116001155');
    assert.match(url, /\/api\/report\/GetImageByNum\/081253081046137249104234083090073041121116001155$/);
    assert.equal(url.includes('fileNumber='), false);
    assert.equal(caSiImageUrls('abc')[0], caSiImageUrl('abc'));
  });

  it('parses CEO/CFO/Secretary/Directors/Managers from the recorded SI table', () => {
    const text = readFileSync(join(dir, 'ca-si-officer-table.txt'), 'utf8');
    const rows = parseSiOfficerTable(text);
    assert.ok(rows.some((r) => r.name === 'JANE SAMPLE' && /CEO/i.test(r.title)));
    assert.ok(rows.some((r) => r.name === 'ALEX SAMPLE'));
    assert.ok(rows.some((r) => r.name === 'PAT MORGAN'));
  });

  it('parses the live bizfileOnline SI PDF officer table (web-fetch text)', () => {
    const text = readFileSync(join(dir, 'ca-si-officer-table-pdf.txt'), 'utf8');
    const rows = parseSiOfficerTable(text);
    assert.ok(rows.some((r) => r.name === 'JANE SAMPLE' && /Chief Executive Officer/i.test(r.title)));
    assert.ok(rows.some((r) => r.name === 'ALEX SAMPLE' && /Director/i.test(r.title)));
    assert.equal(
      rows.some((r) => /agent/i.test(r.title) || /JANE AGENT/i.test(r.name) || /OAKLAND/i.test(r.name)),
      false,
    );
  });

  it('reads document ids from the recorded history shape', () => {
    const history = JSON.parse(readFileSync(join(dir, 'ca-si-history.json'), 'utf8'));
    const ids = documentIdsFromPayload(history);
    assert.equal(ids.length, 1);
    assert.equal(caSiImageUrl(ids[0]), `https://bizfileonline.sos.ca.gov/api/report/GetImageByNum/${ids[0]}`);
  });

  it('does not parse officers from Incapsula block HTML', async () => {
    const html = readFileSync(join(dir, 'ca-incapsula-block.html'), 'utf8');
    const got = await fetchCaStatementOfficers(
      { EntityID: '202399900002', EntityName: 'Sample Builders LLC' },
      { live: false, caSiText: html },
    );
    assert.equal(got.entries.length, 0);
  });

  it('OCRs PDF/image SI bytes returned on the Apify path', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0x00]);
    const got = await fetchCaStatementOfficers(
      { EntityID: '202399900002', EntityName: 'Sample Builders LLC' },
      {
        live: true,
        apifyEnabled: true,
        fetch: async () =>
          new Response(readFileSync(join(dir, 'ca-incapsula-block.html')), {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        apifyFetchHtml: async () => ({
          html: '',
          usd: 0.015,
          bytesBase64: Buffer.from(jpeg).toString('base64'),
          contentType: 'image/jpeg',
        }),
        ocr: async () => 'Chief Executive Officer: JANE SAMPLE',
      },
    );
    assert.equal(got.via_apify, true);
    assert.equal(got.ocr_used, true);
    assert.equal(got.entries[0]?.name, 'JANE SAMPLE');
    assert.equal(parseOfficerRoster(got.text)[0]?.name, 'JANE SAMPLE');
  });
});
