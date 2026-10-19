import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  companySearchQueries,
  coreCompanySearchName,
  hasCompanyWord,
  htmlToText,
  isNycCity,
  isPlaceName,
  labeledValue,
  looksLikeSolePropPerson,
  namesMatchNormalized,
  normalizeCompanyName,
  normalizeState,
  parseBoardPersonName,
  personKey,
  pickBestNameMatch,
  pickBestNameMatchScored,
  sodaNameNeedle,
  splitPersonName,
  splitLegalAndDba,
  trigramSimilarity,
  validateOfficerPersonName,
} from './names.js';
import { parseNyOpenDataJson } from './nyOpenData.js';
import { parsePaOpenDataJson } from './paOpenData.js';
import { sodaWhereContains, sodaWhereContainsLoose } from './soda.js';
import { pickTxFranchiseRow } from './txOpenData.js';
import { decodeCacheBody, encodeCacheBody } from './cache.js';
import { parseMaSosResultLinks, parseMaSosText } from './maSos.js';
import { shouldRetryMaViaProxy } from './http.js';
import { parsePaDosText } from './paDos.js';
import { nycDobSearchUrl } from './nycDob.js';
import { nyDosSearchUrl } from './nyDos.js';
import { txTdlrSearchUrl } from './txTdlr.js';
import { looksBlocked, setBoardFetch } from './http.js';
import { resolveMaCsl } from './maCsl.js';
import { setBoardCacheReadForTests } from './cache.js';
import { resolveMaSos } from './maSos.js';
import { parseNycDobJson } from './nycDob.js';
import { parseWaLniJson, parseWaLniText } from './waLni.js';
import { parseTxTdlrJson, parseTxTdlrText } from './txTdlr.js';
import { hasRealMaResult, parseMaCslText } from './maCsl.js';
import { createMnIndex, ingestMnCsv, lookupMnIndex, parseMnDliCsv, parseMnDliText } from './mnDli.js';
import { parsePaHicText } from './paHic.js';
import { sampleOwnerRows } from './types.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = (name: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');

describe('splitPersonName', () => {
  it('splits two and three tokens on the last word', () => {
    assert.deepEqual(splitPersonName('JANE PUBLIC'), {
      first_name: 'JANE',
      last_name: 'PUBLIC',
      full_name_raw: 'JANE PUBLIC',
      review_flag: false,
    });
    assert.equal(splitPersonName('JANE Q PUBLIC').last_name, 'PUBLIC');
    assert.equal(splitPersonName('JANE Q PUBLIC').first_name, 'JANE Q');
  });

  it('does not guess first/last on four tokens', () => {
    const split = splitPersonName('MARY ELLEN ANN GARCIA');
    assert.equal(split.first_name, null);
    assert.equal(split.review_flag, true);
  });

  it('flags a single token as a partial name', () => {
    const split = splitPersonName('JANE');
    assert.equal(split.first_name, null);
    assert.equal(split.last_name, 'JANE');
    assert.equal(split.review_flag, true);
  });
});

describe('officer person name validation', () => {
  it('strips honorifics and rejects cities, company words, and partial names', () => {
    const ok = validateOfficerPersonName('REV DR JANE SAMPLE DVM');
    assert.equal(ok.ok, true);
    assert.equal(ok.first_name, 'JANE');
    assert.equal(ok.last_name, 'SAMPLE');
    assert.equal(ok.review_flag, false);

    assert.equal(validateOfficerPersonName('SAN DIEGO').ok, false);
    assert.equal(validateOfficerPersonName('SAN DIEGO').reason, 'place');
    assert.equal(isPlaceName('LOS ANGELES'), true);

    assert.equal(validateOfficerPersonName('ACME ADVISORS').ok, false);
    assert.equal(validateOfficerPersonName('VALLEY GROUP LLC').reason, 'company');
    assert.equal(hasCompanyWord('SMITH ADVISORS'), true);

    const partial = validateOfficerPersonName('JANE');
    assert.equal(partial.ok, false);
    assert.equal(partial.reason, 'partial');
    assert.equal(partial.review_flag, true);

    assert.equal(validateOfficerPersonName('OAKLAND', ['Oakland']).reason, 'place');
    assert.equal(validateOfficerPersonName('JANE SAMPLE', ['Oakland']).ok, true);
  });
});

describe('company search query normalization', () => {
  it('strips DBA, dash/pipe marketing, Division, and Dr…DVM tails', () => {
    assert.equal(coreCompanySearchName('Valley Pets - Dr. Jane Smith DVM'), 'Valley Pets');
    assert.equal(coreCompanySearchName('Acme Advisors | Wealth Management Division'), 'Acme Advisors');
    assert.equal(coreCompanySearchName('Dr. Smith Veterinary'), 'Dr. Smith Veterinary');
    const queries = companySearchQueries('Sample Builders LLC - Extra Marketing');
    assert.equal(queries[0], 'Sample Builders LLC');
    assert.ok(queries.includes('SAMPLE BUILDERS'));
  });
});

describe('parseBoardPersonName', () => {
  it('splits LAST, FIRST M from registry dumps', () => {
    const split = parseBoardPersonName('SMITH, JOHN A');
    assert.equal(split.first_name, 'JOHN A');
    assert.equal(split.last_name, 'SMITH');
    assert.equal(split.review_flag, false);
  });
});

describe('looksBlocked', () => {
  it('does not treat a CSLB page with a recaptcha widget as blocked', () => {
    assert.equal(
      looksBlocked(200, 'Business Information\nACME INC\nLicense Status\nCurrent and active\ng-recaptcha captcha widget'),
      false,
    );
  });

  it('treats a Turnstile search shell as blocked', () => {
    assert.equal(looksBlocked(200, '<div class="cf-turnstile"></div>Please wait'), true);
  });
});

describe('normalizeCompanyName', () => {
  it('strips punctuation, legal suffixes, and DBA tails', () => {
    assert.equal(normalizeCompanyName('Smith HVAC, L.L.C. DBA Cool Air'), 'SMITH HVAC');
    assert.equal(normalizeCompanyName('J & J ELECTRIC INC'), 'J AND J ELECTRIC');
  });
});

describe('splitLegalAndDba', () => {
  it('keeps the trade name that normalizeCompanyName would strip', () => {
    assert.deepEqual(splitLegalAndDba('Sample Builders LLC DBA Sample Crew'), {
      legal: 'Sample Builders LLC',
      dba: 'Sample Crew',
    });
    assert.equal(splitLegalAndDba('Sample Builders LLC').dba, null);
  });
});

describe('sole prop person heuristic', () => {
  it('accepts 2–3 word names without company words', () => {
    assert.equal(looksLikeSolePropPerson('MARY ELLEN'), true);
    assert.equal(looksLikeSolePropPerson('VALLEY ROOFING'), false);
    assert.equal(looksLikeSolePropPerson('ACME CONSTRUCTION'), false);
    assert.equal(hasCompanyWord('VALLEY SERVICES'), true);
  });
});

describe('geo helpers', () => {
  it('normalizes state names and NYC cities', () => {
    assert.equal(normalizeState('California'), 'CA');
    assert.equal(normalizeState('Illinois'), 'IL');
    assert.equal(normalizeState('Colorado'), 'CO');
    assert.equal(isNycCity('Brooklyn'), true);
    assert.equal(isNycCity('Albany'), false);
  });
});

describe('htmlToText', () => {
  it('strips tags to lines', () => {
    const text = htmlToText('<div>Business Information</div><p>ACME INC</p>');
    assert.match(text, /Business Information/);
    assert.match(text, /ACME INC/);
  });

  it('turns </td> </tr> </div> </p> and <br> into newlines', () => {
    const text = htmlToText(
      '<tr><td>License Status</td><td>This license is current and active.</td></tr><div>Entity</div><p>Corporation</p>Business Phone<br>(916) 555-0100',
    );
    assert.match(text, /License Status\n+This license is current and active/);
    assert.match(text, /Entity\n+Corporation/);
    assert.match(text, /Business Phone\n+\(916\) 555-0100/);
  });
});

describe('labeledValue', () => {
  it('captures a value on the same line or the next line', () => {
    assert.equal(labeledValue('License Status This license is current and active.', 'License Status'), 'This license is current and active.');
    assert.equal(labeledValue('License Status\n This license is current and active.', 'License Status'), 'This license is current and active.');
  });
});

describe('normalized name match', () => {
  it('matches after stripping punctuation, legal suffixes, and DBA tails', () => {
    assert.equal(namesMatchNormalized('Smith HVAC, L.L.C. DBA Cool Air', 'SMITH HVAC'), true);
    assert.equal(pickBestNameMatch('Acme Builders LLC', [{ n: 'ACME BUILDERS' }, { n: 'OTHER CO' }], (r) => r.n)?.n, 'ACME BUILDERS');
    assert.equal(pickBestNameMatch('Acme', [{ n: 'ZETA ROOFING' }], (r) => r.n), null);
  });
});

describe('trigram fallback', () => {
  it('scores near-equal names above the threshold and rejects unrelated ones', () => {
    assert.ok(trigramSimilarity('JOHNSON MECHANICAL GROUP', 'JOHNSON MECHNICAL GRP') >= 0.48);
    assert.ok(trigramSimilarity('ACME BUILDERS', 'ZETA ROOFING') < 0.4);
    const hit = pickBestNameMatchScored(
      'Johnson Mechanical Group LLC',
      [{ n: 'JOHNSON MECHNICAL GRP', city: 'Austin' }, { n: 'ZETA ROOFING', city: 'Dallas' }],
      (r) => r.n,
      { allowTrigram: true, city: 'Austin', cityOf: (r) => r.city },
    );
    assert.equal(hit?.item.n, 'JOHNSON MECHNICAL GRP');
    assert.equal(hit?.method, 'trigram');
    const noSubstring = pickBestNameMatchScored(
      'Builders LLC',
      [{ n: 'ACME BUILDERS LLC' }],
      (r) => r.n,
      { allowTrigram: true, allowSubstring: false, minTrigram: 0.8 },
    );
    assert.equal(noSubstring, null);
    const stillSubstring = pickBestNameMatchScored(
      'Builders LLC',
      [{ n: 'ACME BUILDERS LLC' }],
      (r) => r.n,
      { allowTrigram: false },
    );
    assert.equal(stillSubstring?.method, 'substring');
    const cityTie = pickBestNameMatchScored(
      'Acme Builders LLC',
      [
        { n: 'ACME BUILDERS', city: 'Fresno' },
        { n: 'ACME BUILDERS', city: 'Oakland' },
      ],
      (r) => r.n,
      { city: 'Oakland', cityOf: (r) => r.city, allowTrigram: false },
    );
    assert.equal(cityTie?.item.city, 'Oakland');
    assert.ok((cityTie?.score || 0) > 100);
    assert.equal(sodaNameNeedle('Smith HVAC, LLC DBA Cool'), 'SMITH HVAC');
    assert.match(sodaWhereContains('business_name', 'Smith HVAC Heating Cooling LLC'), /SMITH/);
    assert.match(sodaWhereContains('business_name', 'Smith HVAC Heating Cooling LLC'), /COOLING/);
    assert.match(sodaWhereContainsLoose('business_name', 'Smith HVAC Heating Cooling LLC'), /SMITH/);
    assert.match(sodaWhereContainsLoose('business_name', 'Smith HVAC Heating Cooling LLC'), /HVAC/);
    assert.equal(sodaWhereContainsLoose('business_name', 'Smith HVAC Heating Cooling LLC').includes('COOLING'), false);
  });
});

describe('open-data parsers', () => {
  it('reads a NY chairman from official corp JSON', () => {
    const result = parseNyOpenDataJson(
      [
        {
          current_entity_name: 'ACME BUILDERS LLC',
          chairman_name: 'PAT KIM',
          location_city: 'BROOKLYN',
        },
      ],
      'Acme Builders, Inc.',
      'u',
      'Brooklyn',
    );
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0]?.last_name, 'KIM');
    assert.equal(result.coverage_reason, null);
  });

  it('uses a person-style NY DOS process name when chairman is empty', () => {
    const result = parseNyOpenDataJson(
      [
        {
          current_entity_name: 'ACME BUILDERS LLC',
          dos_process_name: 'PAT KIM',
          location_city: 'BROOKLYN',
        },
      ],
      'Acme Builders LLC',
      'u',
      'Brooklyn',
    );
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0]?.last_name, 'KIM');
  });

  it('picks a TX franchise taxpayer by normalized name', () => {
    const hit = pickTxFranchiseRow(
      [
        { taxpayer_number: '123', taxpayer_name: 'ACME BUILDERS INC', taxpayer_city: 'AUSTIN', taxpayer_zip: '78701' },
        { taxpayer_number: '999', taxpayer_name: 'ZETA ROOFING LLC', taxpayer_city: 'DALLAS', taxpayer_zip: '75201' },
      ],
      'Acme Builders LLC',
      'Austin',
      '78701',
    );
    assert.equal(hit?.taxpayerId, '123');
    assert.equal(hit?.method, 'exact');
  });

  it('reads PA officers from the registered-business dump', () => {
    const result = parsePaOpenDataJson(
      [
        {
          business_name: 'ACME BUILDERS LLC',
          filing_number: '1',
          first_name: 'PAT',
          last_name: 'KIM',
          party_type: 'President',
          city: 'PHILADELPHIA',
          zip: '19103',
        },
      ],
      'Acme Builders LLC',
      'u',
      'Philadelphia',
      '19103',
    );
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0]?.last_name, 'KIM');
    assert.equal(result.source, 'pa_dos');
  });

  it('returns name_miss when rows exist but the company does not match', () => {
    const result = parsePaOpenDataJson(
      [{ business_name: 'ZETA ROOFING LLC', first_name: 'A', last_name: 'B', party_type: 'Owner' }],
      'Acme Builders LLC',
      'u',
    );
    assert.equal(result.people.length, 0);
    assert.equal(result.coverage_reason, 'name_miss');
  });
});

describe('cache query/url envelope', () => {
  it('round-trips query string and fetched URL without leaking into parse text', () => {
    const wrapped = encodeCacheBody('License Status This license is current and active.', {
      query_string: 'searchName=ACME',
      fetched_url: 'https://example.test/search?q=ACME',
    });
    const decoded = decodeCacheBody(wrapped);
    assert.equal(decoded.query_string, 'searchName=ACME');
    assert.equal(decoded.fetched_url, 'https://example.test/search?q=ACME');
    assert.equal(decoded.text, 'License Status This license is current and active.');
  });
});

describe('name-search URLs', () => {
  it('logs the exact query string for NYC / NY DOS / TDLR', () => {
    assert.equal(nycDobSearchUrl({ license: '12345' }).query_string, 'license_number=12345');
    assert.match(nycDobSearchUrl({ businessName: "O'BRIEN HVAC LLC" }).query_string, /business_name/i);
    assert.equal(nyDosSearchUrl('Smith HVAC, LLC DBA Cool').query_string, 'searchName=SMITH HVAC');
    assert.equal(txTdlrSearchUrl({ license: 'TECL-009' }).query_string, 'license_number=009');
    assert.match(txTdlrSearchUrl({ businessName: 'Smith HVAC LLC' }).query_string, /SMITH/);
    assert.match(txTdlrSearchUrl({ businessName: 'Smith HVAC LLC' }).query_string, /HVAC/);
  });
});

describe('other board parsers', () => {
  it('parses NYC DOB JSON licensee as owner', () => {
    const result = parseNycDobJson(
      [
        {
          first_name: 'GEORGE',
          last_name: 'PAPADIONISOPOULOS',
          license_status: 'ACTIVE',
          business_phone_number: '3476547642',
        },
      ],
      'https://data.cityofnewyork.us/resource/cnwx-a5xx.json',
    );
    assert.equal(result.people[0]?.role, 'owner');
    assert.equal(result.people[0]?.source, 'nyc_dob');
    assert.equal(result.coverage_reason, null);
    assert.equal(result.people[0]?.business_phone, '3476547642');
  });

  it('marks expired NYC licenses inactive', () => {
    const result = parseNycDobJson([{ first_name: 'A', last_name: 'B', license_status: 'EXPIRED' }], 'u');
    assert.equal(result.coverage_reason, 'inactive_license');
    assert.equal(result.people.length, 0);
  });

  it('parses WA governing persons', () => {
    const result = parseWaLniText(
      'Governing persons\nALICE BAKER\nLicense\nActive registration\n',
      'https://secure.lni.wa.gov/verify/Detail.aspx?LIC=1',
    );
    assert.equal(result.people[0]?.last_name, 'BAKER');
    assert.equal(result.people[0]?.source, 'wa_lni');
  });

  it('parses TDLR / MA / MN / PA holder lines', () => {
    assert.equal(parseTxTdlrText('Licensee: SAM LEE\nActive\n', 'u').people[0]?.last_name, 'LEE');
    assert.equal(parseMaCslText(fixture('ma-accela-result.txt'), 'u').people[0]?.role, 'owner');
    assert.equal(parseMaCslText(fixture('ma-accela-result.txt'), 'u').people[0]?.last_name, 'KIM');
    assert.equal(hasRealMaResult(fixture('ma-accela-form.txt')), false);
    assert.equal(hasRealMaResult(fixture('ma-accela-result.txt')), true);
    assert.equal(
      parseMnDliText('Qualifying Person: CHRIS ONG\nActive\n', 'u').people[0]?.role,
      'qualifying_individual',
    );
    assert.equal(parsePaHicText('Owner: RILEY COHEN\n', 'u').people[0]?.source, 'pa_hic');
    assert.equal(parsePaHicText('<div class="cf-turnstile"></div>', 'u').coverage_reason, 'blocked');
    assert.equal(parsePaDosText('Entity Name: ACME BUILDERS LLC\nPresident: RILEY COHEN\n', 'u', 'Acme Builders LLC').people[0]?.source, 'pa_dos');
    assert.equal(parseMaSosText('Entity Name: ACME BUILDERS LLC\nPresident: PAT KIM\n', 'u', 'Acme Builders LLC').people[0]?.source, 'ma_sos');
    const table = parseMaSosText(fixture('ma-sos-summary.txt'), 'u', 'Acme Builders LLC');
    assert.equal(table.people.length >= 2, true);
    assert.equal(table.people[0]?.last_name, 'KIM');
    assert.equal(table.match_method, 'exact');
    const links = parseMaSosResultLinks(
      '<a href="CorpSummary.aspx?sysvalue=abc">ACME BUILDERS LLC</a><a href="CorpSummary.aspx?sysvalue=def">OTHER LLC</a>',
    );
    assert.equal(links.length, 2);
    assert.match(links[0]!.url, /CorpSummary\.aspx\?sysvalue=abc/);
  });

  it('retries an Imperva 200 SOS miss through the residential proxy gate', () => {
    assert.equal(
      shouldRetryMaViaProxy({
        named: false,
        blocked: true,
        coverage_reason: 'blocked',
        http_status: 200,
        body: '_Incapsula_Resource',
      }),
      true,
    );
  });

  it('ignores Accela chrome that only says Licensee', () => {
    const result = parseMaCslText('Search\nLicensee\nLicense Type\nPlease enter a license number\n', 'u');
    assert.equal(result.people.length, 0);
    assert.equal(result.coverage_reason, 'not_found');
  });

  it('parses TDLR SODA owner_name for electrical trades', () => {
    const result = parseTxTdlrJson(
      [
        {
          license_type: 'Electrical Contractor',
          license_number: '12345',
          owner_name: 'LEE, SAM',
          business_telephone: '2145550100',
          license_expiration_date_mmddccyy: '01012099',
        },
      ],
      'u',
    );
    assert.equal(result.people[0]?.last_name, 'LEE');
    assert.equal(result.people[0]?.first_name, 'SAM');
    assert.equal(result.coverage_reason, null);
  });

  it('skips TDLR rows that are not electrical or HVAC', () => {
    const result = parseTxTdlrJson([{ license_type: 'Cosmetology Operator', owner_name: 'LEE, SAM' }], 'u');
    assert.equal(result.people.length, 0);
    assert.equal(result.coverage_reason, 'not_found');
  });

  it('accepts a name-matched TDLR owner when the license type is not HVAC/electrical', () => {
    const result = parseTxTdlrJson(
      [
        {
          license_type: 'General Contractor',
          business_name: 'ACME BUILDERS LLC',
          owner_name: 'LEE, SAM',
          license_expiration_date_mmddccyy: '01012099',
        },
      ],
      'u',
      'Acme Builders LLC',
    );
    assert.equal(result.people[0]?.last_name, 'LEE');
    assert.equal(result.coverage_reason, null);
  });

  it('parses WA L&I principal JSON as LAST, FIRST', () => {
    const result = parseWaLniJson(
      [{ principalname: 'BAKER, ALICE M', contractorlicensenumber: 'STATUEC903MA' }],
      'u',
      { phone: '2065550100', status: 'ACTIVE' },
    );
    assert.equal(result.people[0]?.first_name, 'ALICE M');
    assert.equal(result.people[0]?.last_name, 'BAKER');
    assert.equal(result.people[0]?.business_phone, '2065550100');
  });

  it('matches a NYC business_name after suffix/DBA normalize', () => {
    const result = parseNycDobJson(
      [
        {
          first_name: 'GEORGE',
          last_name: 'PAPADIONISOPOULOS',
          license_status: 'ACTIVE',
          business_name: 'ACME BUILDERS LLC DBA ACE',
          business_phone_number: '3476547642',
        },
      ],
      'u',
      'Acme Builders, Inc.',
    );
    assert.equal(result.people.length, 1);
    assert.equal(result.coverage_reason, null);
  });

  it('joins a MN business to a unique qualifying person at the same address', () => {
    const csv = [
      'Bus_Pers,License_Type,License_Subtype,Name,DBA_Name,Addr1,Addr2,City,St,Zip,Phone_No,Email_Address,Lic_Number,Status,Orig_Date,Exp_Date,Enforcement_Action,Renewal_in_Progress',
      'Business,Residential Contractors,Residential Building Contractor,ACME BUILDERS LLC,,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,BC000111,Issued,,,,',
      'Personal,Residential Contractors,Qualifying Builder,"JONES, PAT",,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,QB000111,Issued,,,,',
    ].join('\n');
    const result = parseMnDliCsv(csv, 'Acme Builders LLC DBA Ace Construction', 'u');
    assert.equal(result.people[0]?.role, 'qualifying_individual');
    assert.equal(result.people[0]?.last_name, 'JONES');
    assert.equal(result.people[0]?.confidence, 'medium');
  });

  it('joins a MN qualifier on the same phone when addresses differ', () => {
    const csv = [
      'Bus_Pers,License_Type,License_Subtype,Name,DBA_Name,Addr1,Addr2,City,St,Zip,Phone_No,Email_Address,Lic_Number,Status,Orig_Date,Exp_Date,Enforcement_Action,Renewal_in_Progress',
      'Business,Residential Contractors,Residential Building Contractor,ACME BUILDERS LLC,,200 OAK ST,,MINNEAPOLIS,MN,55401,6125550100,,BC000222,Issued,,,,',
      'Personal,Residential Contractors,Qualifying Builder,"JONES, PAT",,9 PINE AVE,,BLOOMINGTON,MN,55420,6125550100,,QB000222,Issued,,,,',
    ].join('\n');
    const result = parseMnDliCsv(csv, 'Acme Builders LLC', 'u');
    assert.equal(result.people[0]?.last_name, 'JONES');
    assert.equal(result.coverage_reason, null);
  });

  it('links one MN qualifier to two companies only when the company name matches', () => {
    const csv = [
      'Bus_Pers,License_Type,License_Subtype,Name,DBA_Name,Addr1,Addr2,City,St,Zip,Phone_No,Email_Address,Lic_Number,Status,Orig_Date,Exp_Date,Enforcement_Action,Renewal_in_Progress',
      'Business,Residential Contractors,Residential Building Contractor,ACME BUILDERS LLC,,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,BC000111,Issued,,,,',
      'Personal,Residential Contractors,Qualifying Builder,"JONES, PAT",,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,QB000111,Issued,,,,',
      'Business,Residential Contractors,Residential Building Contractor,ZETA ROOFING LLC,,200 OAK ST,,MINNEAPOLIS,MN,55401,6125559999,,BC000222,Issued,,,,',
      'Personal,Residential Contractors,Qualifying Builder,"JONES, PAT",,200 OAK ST,,MINNEAPOLIS,MN,55401,6125559999,,QB000222,Issued,,,,',
      'Business,Residential Contractors,Residential Building Contractor,OTHER BUILDERS LLC,,999 PINE ST,,ST PAUL,MN,55101,6515550199,,BC000333,Issued,,,,',
    ].join('\n');
    const acme = parseMnDliCsv(csv, 'Acme Builders LLC', 'u');
    const zeta = parseMnDliCsv(csv, 'Zeta Roofing LLC', 'u');
    const other = parseMnDliCsv(csv, 'Other Builders LLC', 'u');
    assert.equal(acme.people.length, 1);
    assert.equal(acme.people[0]?.last_name, 'JONES');
    assert.equal(acme.coverage_reason, null);
    assert.equal(zeta.people.length, 1);
    assert.equal(zeta.people[0]?.last_name, 'JONES');
    assert.equal(zeta.coverage_reason, null);
    assert.equal(other.people.length, 0);
    assert.equal(other.coverage_reason, 'name_miss');
  });

  it('matches a MN DLI row by exact license number even when the permit company name differs', () => {
    const csv = [
      'Bus_Pers,License_Type,License_Subtype,Name,DBA_Name,Addr1,Addr2,City,St,Zip,Phone_No,Email_Address,Lic_Number,Status,Orig_Date,Exp_Date,Enforcement_Action,Renewal_in_Progress',
      'Business,Residential Contractors,Residential Building Contractor,ACME BUILDERS LLC,,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,BC000111,Issued,,,,',
      'Personal,Residential Contractors,Qualifying Builder,"JONES, PAT",,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,QB000111,Issued,,,,',
      'Business,Residential Contractors,Residential Building Contractor,ZETA ROOFING LLC,,200 OAK ST,,MINNEAPOLIS,MN,55401,6125559999,,BC000222,Issued,,,,',
    ].join('\n');
    const result = parseMnDliCsv(csv, 'Unrelated Ventures LLC', 'u', 'BC-000111');
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0]?.last_name, 'JONES');
    assert.equal(result.match_method, 'license');
    assert.equal(result.coverage_reason, null);
  });

  it('rejects a MN name-only coincidence instead of assigning an unrelated qualifier', () => {
    const csv = [
      'Bus_Pers,License_Type,License_Subtype,Name,DBA_Name,Addr1,Addr2,City,St,Zip,Phone_No,Email_Address,Lic_Number,Status,Orig_Date,Exp_Date,Enforcement_Action,Renewal_in_Progress',
      'Business,Residential Contractors,Residential Building Contractor,NORTHSTAR CONSTRUCTION LLC,,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,BC000111,Issued,,,,',
      'Personal,Residential Contractors,Qualifying Builder,"JONES, PAT",,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,QB000111,Issued,,,,',
    ].join('\n');
    const similar = parseMnDliCsv(csv, 'Northland Construction LLC', 'u');
    const substring = parseMnDliCsv(csv, 'Construction LLC', 'u');
    assert.equal(similar.people.length, 0);
    assert.equal(similar.coverage_reason, 'name_miss');
    assert.equal(substring.people.length, 0);
    assert.equal(substring.coverage_reason, 'name_miss');
  });

  it('reuses one MN index for license and name lookups without re-parsing', () => {
    const csv = [
      'Bus_Pers,License_Type,License_Subtype,Name,DBA_Name,Addr1,Addr2,City,St,Zip,Phone_No,Email_Address,Lic_Number,Status,Orig_Date,Exp_Date,Enforcement_Action,Renewal_in_Progress',
      'Business,Residential Contractors,Residential Building Contractor,ACME BUILDERS LLC,,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,BC000111,Issued,,,,',
      'Personal,Residential Contractors,Qualifying Builder,"JONES, PAT",,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,QB000111,Issued,,,,',
      'Business,Residential Contractors,Residential Building Contractor,ZETA ROOFING LLC,,200 OAK ST,,MINNEAPOLIS,MN,55401,6125559999,,BC000222,Issued,,,,',
    ].join('\n');
    const index = createMnIndex();
    ingestMnCsv(index, csv);
    const byName = lookupMnIndex(index, 'Acme Builders LLC', 'u');
    const byLic = lookupMnIndex(index, 'Unrelated Ventures LLC', 'u', 'BC-000111');
    const miss = lookupMnIndex(index, 'Other Builders LLC', 'u');
    assert.equal(index.rows, 3);
    assert.equal(byName.people.length, 1);
    assert.equal(byName.match_method, 'exact');
    assert.equal(byLic.people.length, 1);
    assert.equal(byLic.match_method, 'license');
    assert.equal(miss.coverage_reason, 'name_miss');
  });
});

describe('MA license miss routes to SOS', () => {
  it('does not stop on Accela/OPSI block when SOS has officers', async () => {
    setBoardCacheReadForTests(async () => null);
    setBoardFetch(async (input) => {
      const url = String(input);
      if (url.includes('elicensing21.mass.gov')) {
        return new Response('Access Denied', { status: 404 });
      }
      if (url.includes('madpl.mylicense.com')) {
        return new Response('Access Denied', { status: 403 });
      }
      if (url.includes('corp.sec.state.ma.us')) {
        return new Response('Entity Name: ACME BUILDERS LLC\nPresident: PAT KIM\n', { status: 200 });
      }
      return new Response('no', { status: 404 });
    });
    try {
      const result = await resolveMaCsl({
        list_id: 'x',
        lead_id: 1,
        company_name: 'Acme Builders LLC',
        state: 'MA',
      });
      assert.equal(result.source, 'ma_sos');
      assert.equal(result.people.length, 1);
      assert.equal(result.people[0]?.last_name, 'KIM');
      assert.equal(result.coverage_reason, null);
    } finally {
      setBoardFetch(null);
      setBoardCacheReadForTests(null);
    }
  });

  it('bypasses a cached Incapsula SOS row and live-fetches officers', async () => {
    const prev = process.env.APIFY_PROXY_PASSWORD;
    delete process.env.APIFY_PROXY_PASSWORD;
    let fetches = 0;
    setBoardCacheReadForTests(async (board) => {
      if (board !== 'ma_sos') return null;
      return {
        board: 'ma_sos',
        cache_key: 'x',
        http_status: 200,
        body: 'Request unsuccessful. Incapsula incident ID /_Incapsula_Resource',
        fetched_at: '2026-10-14',
      };
    });
    setBoardFetch(async (input) => {
      fetches += 1;
      const url = String(input);
      if (url.includes('corp.sec.state.ma.us')) {
        return new Response('Entity Name: ACME BUILDERS LLC\nPresident: PAT KIM\n', { status: 200 });
      }
      return new Response('Access Denied', { status: 404 });
    });
    try {
      const result = await resolveMaSos({
        list_id: 'x',
        lead_id: 9,
        company_name: 'Acme Builders LLC',
        state: 'MA',
      });
      assert.equal(fetches >= 1, true);
      assert.equal(result.cached, undefined);
      assert.equal(result.people[0]?.last_name, 'KIM');
    } finally {
      setBoardFetch(null);
      setBoardCacheReadForTests(null);
      if (prev === undefined) delete process.env.APIFY_PROXY_PASSWORD;
      else process.env.APIFY_PROXY_PASSWORD = prev;
    }
  });

  it('marks Imperva 200 as blocked without captcha so the proxy gate can retry', async () => {
    const prev = process.env.APIFY_PROXY_PASSWORD;
    const prevLower = process.env.apify_proxy_password;
    process.env.APIFY_PROXY_PASSWORD = 'must-not-be-used';
    delete process.env.apify_proxy_password;
    setBoardCacheReadForTests(async () => null);
    const hosts: string[] = [];
    setBoardFetch(async (input) => {
      const url = String(input);
      try {
        hosts.push(new URL(url).host);
      } catch {
        hosts.push('unknown');
      }
      if (url.includes('corp.sec.state.ma.us')) {
        return new Response('Request unsuccessful. Incapsula incident ID /_Incapsula_Resource', { status: 200 });
      }
      return new Response('Access Denied', { status: 403 });
    });
    try {
      const result = await resolveMaCsl({
        list_id: 'x',
        lead_id: 2,
        company_name: 'Acme Builders LLC',
        state: 'MA',
      });
      assert.equal(result.blocked, true);
      assert.equal(result.captcha, false);
      assert.equal(result.coverage_reason, 'blocked');
      assert.equal(result.people.length, 0);
      assert.equal(hosts.includes('proxy.apify.com'), false);
      assert.equal(shouldRetryMaViaProxy({
        named: false,
        captcha: result.captcha,
        blocked: result.blocked,
        coverage_reason: result.coverage_reason,
        http_status: result.http_status,
      }), true);
    } finally {
      setBoardFetch(null);
      setBoardCacheReadForTests(null);
      if (prev === undefined) delete process.env.APIFY_PROXY_PASSWORD;
      else process.env.APIFY_PROXY_PASSWORD = prev;
      if (prevLower === undefined) delete process.env.apify_proxy_password;
      else process.env.apify_proxy_password = prevLower;
    }
  });
});

describe('sampleOwnerRows', () => {
  it('omits names from samples', () => {
    const sample = sampleOwnerRows([
      {
        people: [
          {
            first_name: 'JANE',
            last_name: 'PUBLIC',
            full_name_raw: 'JANE PUBLIC',
            role: 'owner',
            source: 'cslb',
            source_url: 'u',
            confidence: 'high',
          },
        ],
        coverage_reason: null,
        source: 'cslb',
      },
    ]);
    const blob = JSON.stringify(sample);
    assert.equal(blob.includes('JANE'), false);
    assert.equal(blob.includes('PUBLIC'), false);
    assert.equal(sample[0]?.role, 'owner');
    assert.equal(sample[0]?.source, 'cslb');
    assert.equal(personKey('Jane  Public'), 'jane public');
  });
});
