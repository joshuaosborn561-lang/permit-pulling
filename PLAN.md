# US business-owner lookup — Phase 1 plan (DRAFT)

Status: **Phase 2 implemented on this draft PR**. Do not merge to production. Do not deploy. Do not run against live lead tables from this PR. Local CSV probe: `npx tsx scripts/owner_lookup_sample.ts --in companies.csv --out results.csv`.

This document generalizes the existing **permit / license-board** path (`src/server/lib/stateOwners/`, `match_state_owners`) into a **company name + city + state** lookup that does not require a permit or license number. The permit path stays callable and unchanged.

No lead names, company names from the first-use file, or officer names appear here.

---

## 1. Goal and non-goals

**Goal.** Given `{ company_name, city, state }` (optional `domain`), return a person the Email Finder Waterfall can consume in `name_company` mode: first name, last name, title, company, domain if known, official state source URL, confidence.

**Keep working.** CSLB / L&I / NYC DOB / NY DOS / MA CSL+SOS / MN DLI / PA DOS / TX TDLR+SOS / Sunbiz license-board tools, including `match_state_owners` and the per-state aliases.

**Non-goals for this PR.** Live SOS traffic, Supabase writes, Railway deploy, paid officer datasets, captcha solvers, Apify Unblocker.

**Hard rules.**

- Official Secretary of State / Corporation Commission / equivalent sources only for the SOS tier. **Serper (google.serper.dev) is the first owner tier for every state** — cheaper than Apify. A Serper person is accepted only when the organic snippet/page fuzzy-matches the same company name **and** city or state.
- Apify is **fallback HTML fetch** after Serper cannot return a high-confidence owner, for states that block automation, behind `APIFY_MAX_USD`. Never paid Store datasets, never SOSfinder / OpenSOSData / Parse.bot / similar wrappers.
- A blocked/challenge page (Cloudflare “Just a moment”, “Enable JavaScript and cookies”, Incapsula interstitial) is **never** a match and is never parsed for officers.
- No person is waterfall-ready without a confirmed company record. Serper hits are waterfall-ready only at **high** confidence. Do not match the input name against itself.
- Do not treat a registered agent as an owner. Agent-only hits are `coverage_reason=agent_only`, confidence `low`, and are **not** handed to Email Finder.
- MCP replies stay counts / job ids / nameless samples. Persist people server-to-server.
- First-use volume cited below is a **count only**.

---

## 2. Two input paths (do not collapse them)

| Path | Trigger | Today | After this work |
|------|---------|-------|-----------------|
| Permit / license | `license_number` or board-specific id present | CSLB, TDLR, Accela, etc. | Unchanged. `match_state_owners` still routes here. |
| Name | `company_name` + `state` (city strongly preferred) | Only some boards already search by name (MA SOS, PA DOS, Sunbiz, TX Comptroller) | New `lookup_business_owner` MCP tool. |

California is the reason they must stay separate: **CSLB needs a license number**. A contractor list that only has a trade name cannot use `resolveCslb`. The name path uses the Secretary of State, not CSLB.

Phase 2 may optionally fall `match_state_owners` through to the name path when `coverage_reason=no_license_number`. That is **not** in this PR.

---

## 3. Architecture (Phase 2 implements; this PR scaffolds)

```
lookup_business_owner  ──► job store ──► Serper (all 51) ──► per-state SOS adapter
        │                         │              │
        │                         │              ├─ official API / open-data / bulk file
        │                         │              ├─ official HTML (paced)
        │                         │              └─ Apify playwright-scraper ONLY if
        │                         │                 Serper missed AND page is blocked
        ▼                         ▼
  counts + job_id          persist (later): first/last, title, company,
  get_business_owner_job   domain, source_url, confidence
  serper_credits           waterfall_ready: official confirmed record,
  apify_usd_spent          or Serper high confidence only
        │
        ▼
  Email Finder Waterfall (name_company)
```

Reuse, do not fork:

- `normalizeCompanyName` / `pickBestNameMatchScored` / DBA stripping (`names.ts`)
- `PacedBoardClient`, board cache, `BoardJobStopError`
- `runOwnerMatchLoop` lane model (default 6, cap 10) + `SUPABASE_WRITE_CONCURRENCY = 4`
- Existing FL / TX / MA / PA name searches as adapters behind the new router

New modules (scaffolded in this PR):

- `src/server/lib/stateOwners/sos/` — catalog, name-path router, CA BizFile client stub, job store, waterfall field mapper
- `src/server/services/lookupBusinessOwner.ts` — MCP service
- Tools: `lookup_business_owner`, `get_business_owner_job`

### 3.1 MCP contract (top-up bots)

`lookup_business_owner`

| Arg | Purpose |
|-----|---------|
| `source_table` + `where` | Preferred. Page server-side. Do not paste lead rows into chat. |
| `list_id` | Existing calling-list path (optional). |
| `states` | Optional filter. Default: all catalog states, rolled out in the order below. |
| `max_rows` | Cap for a slice. Jobs resume unfinished rows. |
| `estimate_only` | Cost + runtime. No SOS calls. |
| `dry_run` | Parse / count. No writes. Phase 1 default true; **writes are disabled in this PR**. |
| `include_agents` | Default false. If true, still flagged `agent_only` and not waterfall-ready. |

`get_business_owner_job({ job_id })` — `queued | running | completed | failed | stopped`, counters, per-state hit rates, nameless samples, Serper credits, Apify CU if any.

**Waterfall-compatible persist fields** (later writes; not dumped in chat):

```
first_name, last_name, title, company_name, domain,
source_url, confidence, state, source, role
```

Map `title` ← officer title / `OwnerRole`, `confidence` ← `high|medium|low`, `source_url` ← official entity or filing URL. Do not invent LinkedIn.

### 3.2 Name match

Already in tree: suffix strip, trailing `DBA` / `D/B/A` strip, exact → substring → trigram (threshold 0.48), city/ZIP bonus on trigram, 5-point trigram ambiguity gap.

Phase 1 scaffold extends this for the name path:

- Score **legal name and DBA / assumed name** as separate candidates for the same entity.
- Apply city (and ZIP) as a **tie-break on every method**, not only trigram, so two “ACME BUILDERS” hits in different cities pick the requested city.
- Prefer active / good-standing entities when scores tie.
- Sole props: if the input looks like a person and the registry has no entity, do not guess; `not_found` (county FBN is out of scope).

---

## 4. Rollout order

Implement adapters in this order. Do not skip ahead to a blocked state while CA is unfinished.

1. **CA** (bulk of first use)
2. **IL**
3. **GA**
4. **OH**
5. **NC**
6. **AZ**
7. **CO**
8. Remaining jurisdictions (reuse FL/TX/MA/PA/NY/WA/MN that already exist)

---

## 5. California (first)

### 5.1 CSLB (permit path — keep)

- Source: `https://www.cslb.ca.gov/{license}`
- Officers / QI: **yes**, when a license number exists
- Name-only: **no** (`coverage_reason=no_license_number`)
- Rate: existing 1.2s paced client, stop after 3 consecutive non-200
- Key: none
- Anti-bot: some WAF; already handled

### 5.2 Public bizfileOnline search (name path — entity match)

- **Do not use** [calicodev.sos.ca.gov](https://calicodev.sos.ca.gov) / `calico.sos.ca.gov` Business Entity Search. That developer API is **government-agencies-only**. There is no `CA_SOS_API_KEY` / `CA_BIZFILE_API_KEY` on this path.
- Public source: [bizfileOnline.sos.ca.gov](https://bizfileonline.sos.ca.gov/search/business)
  - UI: `https://bizfileonline.sos.ca.gov/search/business`
  - JSON: `POST https://bizfileonline.sos.ca.gov/api/Records/businessSearch` with `SEARCH_VALUE` + `SEARCH_FILTER_TYPE_ID=search`
- Cost of the search itself: **free** (official public site). Compute cost is Apify if the WAF blocks us.
- Fields: entity number/name/status, addresses when present, often **agent**. **Officers are not reliably in the search JSON** — they come from Statement of Information (§5.3).
- Anti-bot: **Incapsula / Imperva**. Datacenter IPs are blocked. **Direct HTTP first.** If the body is a challenge/403, **Apify Playwright + residential proxy** (`groups-RESIDENTIAL`) so the POST runs same-origin after a browser cookie. Never a paid CA dataset, never Unblocker.
- City tie-break: use principal / mailing / agent city on the search row.

**Verdict:** public bizfileOnline is the search tool. A hit with only an agent name is `agent_only` until SI officers parse.

### 5.3 Statement of Information (officers)

Official SOS page: [Business Entities Records Request](https://www.sos.ca.gov/business-programs/business-entities/information-requests). Public bizfile search includes **officer, director, member, manager names and addresses** and SI due date. Plain copies of SI-550 / LLC-12 are printable from [bizfileOnline.sos.ca.gov](https://bizfileonline.sos.ca.gov).

- Returns **officers / managers / at least one member** (not beneficial owners, not shareholders).
- No API field for this. Phase 2: after entity-number match, fetch the SI image or the HTML entity record that lists officers.
- `bizfileOnline` is a JS app behind **Incapsula/Imperva**. Statement of Information images are `GET https://bizfileonline.sos.ca.gov/api/report/GetImageByNum/{documentId}` (document id, not file number). History JSON supplies `DOCUMENT_ID`. Direct HTTP first; **Apify Playwright + residential, then OCR on PDF/image bytes**, if Incapsula blocks. Never a paid CA dataset. There is a paid “master” bulk product (~$100 in help-guide citations); **do not buy it**.

### 5.4 CA weekly bulk (optional, still official)

Audits describe a **free weekly** extract with officers “in record”. Confirm with Josh on the SOS data-request desk before building around it. If the weekly file includes officer names, first-use CA becomes a local join and Apify spend for CA goes to **$0**.

Fictitious business names are **county** filings, not SOS. DBA matching uses SOS assumed-name fields when present, plus the existing `DBA` tail strip on the input.

---

## 6. Priority states after CA

### Illinois

| | |
|--|--|
| Official search | [apps.ilsos.gov/businessentitysearch](https://apps.ilsos.gov/businessentitysearch/) |
| Officers? | **Yes** on the File Detail Report: corp president/secretary; LLC managers or members (as filed on the annual report) |
| Agent | Yes |
| API | **No** public API |
| Bulk | **Yes, free, official** — [Data Transparency Act files](https://www.ilsos.gov/data/bus-serv-home.html) (P.A. 102-0049): Master, Company Name, Agent, **Annual Report**, Assumed/Old Names, Stock, Other |
| Signup / key | None for bulk files |
| Rate limits | N/A for files. Search UI is “individual searches only” |
| Anti-bot | Datacenter IPs refused; search is bot-challenged |
| ToS | **Automated queries, scraping, robots strictly prohibited** on the website ([privacy / terms](https://www.ilsos.gov/privacypolicy.html)) |

**Do not Apify the IL search UI.** Auto-download the official DTA zips from `https://www.ilsos.gov/data/bs/` (`cdxallarp`, `llcallmgr`, name/agent files). If download/index is empty, `coverage_reason=no_source`. Do not scrape the search UI.

### Georgia

| | |
|--|--|
| Official search | [ecorp.sos.ga.gov/businesssearch](https://ecorp.sos.ga.gov/businesssearch) |
| Officers? | **Yes** (search even has an Officer Name field; detail has officers + annual registration) |
| Agent | Yes |
| API | **No official API**. Ignore paid wrappers. |
| Bulk | Paid paper process only — skip |
| Signup / key | None for interactive search |
| Rate limits | Unpublished; pace 1.2s+, stop-after-3 |
| Anti-bot | Bot challenge on the eCorp host |

Direct HTML first. Apify Playwright fallback if blocked.

### Ohio

| | |
|--|--|
| Official search | [businesssearch.ohiosos.gov](https://businesssearch.ohiosos.gov/) |
| Officers? | **No ongoing roster.** Incorporators/organizers at formation; statutory agent on the live portal. No general annual officer list. |
| Agent | Yes (statutory agent) |
| API | None. Monthly **free incremental TXT** reports (new / amended / cancelled) — not a full register, **no officers**. |
| Signup / key | None |
| Rate limits | Unpublished |
| Anti-bot | Challenge on the data host; naive fetchers can ingest a 403 HTML page and think they succeeded |

Confirm the entity via `ajax/endPoints.json` → `businessnamediv` + `NS_{query}_X`. If that JSON cannot be reached, `no_source` (or `blocked` on Cloudflare). **Never** return unverified `agent_only`. Officers are structurally absent — confirmed entities are `agent_only`. Do not spend Apify hoping officers appear. `apify: never`.

### North Carolina

| | |
|--|--|
| Official search | [sosnc.gov business registration search](https://www.sosnc.gov/online_services/search/by_title/_Business_Registration) |
| Officers? | **Yes** — “company officials” refreshed by annual report |
| Agent | Yes |
| API / bulk | Paid FTP ($750 + $2,000/yr cited) — **do not buy** for this project |
| Signup / key | None for HTML |
| Rate limits | Unpublished; pace + stop-after-3 |
| Anti-bot | Bot challenge |

HTML first, Apify if blocked.

### Arizona

| | |
|--|--|
| Office | Arizona Corporation Commission (not SOS) |
| Official search | [arizonabusinesscenter.azcc.gov/businesssearch](https://arizonabusinesscenter.azcc.gov/businesssearch) (eCorp retired Jan 2026 — do not use old eCorp URLs) |
| Officers? | **Yes** — LLC members/managers; corporate officers/directors |
| Agent | Statutory agent |
| API / bulk | Official JSON at `https://api-azbusinessconnectonline.azcc.gov/api` (`businesssearch/public-search`, `getbyidasync`). Datacenter GETs 401; call from a browser/Apify session. No free bulk. Never OpenSOSData. |
| Signup / key | None for public search |
| Rate limits | Unpublished |
| Anti-bot | Angular SPA (`<app-root></app-root>`). Empty JS shell is **not** a match. Direct HTML parse is useless. |

JSON first (in-session), then Apify Playwright. Never fall back to matching the input name against itself.

### Colorado

| | |
|--|--|
| Official search UI | `coloradosos.gov` / `sos.state.co.us` — **Cloudflare managed challenge** (403 to non-browsers) |
| Official data | Socrata **keyless** [Business Entities in Colorado `4ykn-tg5h`](https://data.colorado.gov/Business/Business-Entities-in-Colorado/4ykn-tg5h) |
| Officers? | **No.** Officers/directors/owners are absent from **every** Colorado product, free or paid. |
| Agent | Yes (name + address), plus principal city — usable as a **city tie-break**, not as an owner |
| Signup / key | None |
| Rate limits | Standard Socrata paging (`$limit` / `$offset`) |
| Apify | **Do not** scrape the Cloudflare UI. Query `data.colorado.gov`. |

Name-path owner yield is structurally **zero**. Use the open-data API only to confirm the entity exists / city matches, then `agent_only`.

---

## 7. Remaining jurisdictions (after the seven)

Legend: **Officers** = a named officer/member/manager is in the free official channel we would actually call. **Agent** = registered/statutory agent only. **Apify?** = fallback if HTML is blocked; never for ToS-forbidden or agent-only states.

Existing adapters in this repo are marked **HAVE**.

| ST | Official free source | Officers? | Key / signup | Anti-bot | Apify? | Notes |
|----|----------------------|-----------|--------------|----------|--------|-------|
| AL | SOS business search | Officers (filings) | No | Unreachable / gated | Only if probe says blocked | Bulk limited; citizen restriction on some records requests |
| AK | DCCED entity search + free CSV | Unverified in CSV | No | Bot on download | Maybe | Prefer CSV over UI |
| AR | SOS corp search | Unverified | No | Captcha + attempt counter | Yes if HTML otherwise works | Do not buy $150 subscription |
| CT | Open-data portal (daily) | **Yes** (principals dataset) | No | Open data is open | **No** | Join master + principals; snapshot filing history |
| DE | ICIS name search | **Agent only** | No | Unreachable bulk | **No** | Privacy state. Do not pay per-record. |
| DC | DLCP BOSS (replaced CorpOnline Aug 2026) | Governors in UI, not bulk | No | New portal | Maybe | Re-probe; bulk has no officers |
| FL | Sunbiz HTML + optional Daily API **HAVE** | **Yes** | Optional `florida_sos_api_key` if Cloudflare | HTML often CF | Only if HTML+key fail | Prefer existing adapter; public SFTP also has officers |
| HI | eHawaii business search | Yes (metered images) | Portal account for some docs | Bot | Maybe | $0.05/record contractor — skip paid |
| ID | sosbiz.idaho.gov | Officers in PDFs, not search JSON | No | Open-ish | Maybe for PDFs | |
| IN | INBiz | Unknown until paid | No for search | Bare 403 | Yes if search HTML works | Skip $9.5k bulk |
| IA | Open data | **No** | No (API is paid $2.4k+) | Search gated | **No** for open data | Agent/status only |
| KS | SOS search | **No** in bulk | No | Open | Maybe | Commercial reuse restricted by statute — legal review before bulk |
| KY | web.sos.ky.gov | Yes on filings | No | Open-ish | Maybe | Skip $2k/mo bulk |
| LA | CORA search; API ~18/min | Unverified | No | Search gated | Maybe | Honor 18/min if using API |
| ME | ICRS | **No** in cheap file | No | Search prohibits mining | **No** (ToS) | |
| MD | SDAT Business Express | Limited | No | Cloudflare | Yes | Officers thin |
| MA | SOS CorpSearch **HAVE** | **Yes** | No | Imperva; existing residential retry | Already proxied | Reuse `resolveMaSos` |
| MI | LARA (COFS replaced 2025) | Unverified | No | Bot | Yes | Re-probe new URL |
| MN | SOS portal; DLI dump **HAVE** | DLI QI **yes**; SOS paid | No for DLI | SOS bot | SOS only | Permit path uses DLI; name path can reuse DLI index then SOS |
| MS | SOS corp portal | Yes | No | Bot; host moved | Yes | |
| MO | bsd.sos.mo.gov | Corps yes; **LLC members not required** | No | Bot | Yes | Many LLCs will be `not_found` |
| MT | biz.sosmt.gov | Yes | No | Bot | Yes | Skip per-record paid bulk |
| NE | nebraska.gov/sos/ccorp | Yes | No | Contractor portal flaky | Maybe | |
| NV | esos.nv.gov | Yes | No | Bot | Yes | Skip $125 bulk unless Josh later wants it (still a paid **official** file, not a Store dataset) |
| NH | QuickStart | Yes | No | Bot | Yes | |
| NJ | Treasury BusinessNameSearch | Detail often paywalled | No | Open search, empty detail | **No** until a free detail exists | |
| NM | SOS BFS | Unverified | No | Bare 403 | Yes | |
| NY | Open data **HAVE** + DOS UI | Chairman in some files, **not a roster** | No | UI bot; **open data is open** | **No** for open data | Reuse `nyOpenData` / `nyDos`; expect agent-ish yield |
| ND | FirstStop | **No** in cheap active file | No | Open | **No** | |
| OK | SOS inquiry | Yes, but **$5 / 1–3 records by statute** | No | Open | **No** (statutory paywall) | Skip |
| OR | Open data | **No** | No | Open | **No** | Agent + addresses; active-only extract |
| PA | DOS business search **HAVE** | Limited officers on filings | No | Turnstile on AG HIC (already disabled) | Only DOS if blocked | Reuse `resolvePaDos` |
| RI | CorpSearch | Yes | No | Unknown | Maybe | Skip $250 SFTP |
| SC | businessfilings.sc.gov | Unverified | No | Unreachable in audits | Maybe | Skip $12k bulk |
| SD | sosenterprise | **No** | No | Unreachable | Maybe | |
| TN | TNbear | **No** in cheap extract | No | Captcha on every search | Yes if HTML has officers | |
| TX | Comptroller PIR + SOS **HAVE** | **Yes** (governing persons) | Optional `texas_cpa_api_key` | Open | **No** | Reuse; do not use paid SOSDirect |
| UT | businessregistration.utah.gov | Yes | No | Bot | Yes | Skip metered bulk |
| VT | bizfilings.vermont.gov | Unverified | Login for some bulk | Bot | Yes | |
| VA | CIS + open-data officer file | Corps officers; LLC members often **not** required | No | Open data **stale since late 2024** | Maybe for CIS | Do not trust portal timestamps; prefer live CIS |
| WA | L&I **HAVE**; CCFS SOS | L&I QI yes; SOS governors yes | No | CCFS captcha | SOS only | Permit path stays L&I |
| WV | apps.sos.wv.gov | Yes | No | Search gated | Maybe | Resale restricted on paid feed |
| WI | WDFI | **No** in database (images only) | No | Untested | **No** for owner names | Agent/status |
| WY | WyoBiz | **Corps only**; LLC members **never filed** | No | Open | **No** for LLCs | Most WY rows will be `no_source` |
| DC | see above | | | | | |

**Structurally agent-only / no owner field (do not burn Apify):** CO, DE, IA, ND (cheap file), OH, OR, WI, WY LLCs, NY roster, OK (paywall).

**ToS / statute: do not automate the UI:** IL search, ME search, KS bulk commercial reuse, OK per-record fee.

---

## 8. Serper-first, then Apify fallback

**Serper** (`SERPER_API_KEY`, `https://google.serper.dev/search`) runs first for **every** state, including jurisdictions without an SOS adapter yet.

Queries (~5 credits / row, **$0.001**/query) — **separate** site queries (combined `site:a OR site:b` never ranked registry pages):

1. `<company> <city> <state> officer OR owner OR CEO OR president OR manager`
2. `site:opencorporates.com "…"`
3. `site:bizapedia.com "…"`
4. `site:sunbiz.org "…"`
5. `site:<state SOS host> "…"`

Extract person + title from organic snippets with **case-sensitive 2–3 capitalized name tokens** (review text / `Detail Name` / state codes are never names). Accept only if the snippet fuzzy-matches the **same company name** (trigram ≥ 0.62) and **city or state**. Record `source_url` and a 0–1 `confidence_score`. `waterfall_ready` at **high** confidence: trusted host (OpenCorporates / Bizapedia / Sunbiz / SOS) **or** owner/founder/president + exact company + city. Challenge HTML in a snippet is never a match.

**Apify** runs only when Serper does not return a high-confidence owner **and** official HTML is blocked, behind `APIFY_MAX_USD`.

## 8.1 Apify policy and cost

**Allowed:** `apify/playwright-scraper` (or `apify/web-scraper`) as pay-per-**usage** HTML fetch, `groups-RESIDENTIAL`, media download off, `maxConcurrency` 2–5, **batched startUrls per Actor run** (not one run per lookup). `waitForFinish=60` then poll the run until SUCCEEDED/FAILED. Hard cap `APIFY_MAX_USD` — refuse new runs at the cap. Refused / never-started / failed-with-no-usage runs are **$0**. Reuse existing `APIFY_PROXY_PASSWORD`.

**Forbidden:** Store Actors that sell officer lists; Unblocker / captcha solvers; paid third-party SOS APIs.

Pricing used (Starter, 2026): **$0.20 / CU**, residential **$8 / GB**. 1 CU = 1 GB RAM × 1 hour. Browser ~300 pages/CU average; challenged SOS pages 0.02–0.06 CU/lookup. Residential at 0.5–2 MB/lookup if images/fonts blocked.

| Blocked lookups | Compute (mid) | Residential (mid, media off) | All-in mid | Worst (images/PDFs/retries) |
|-----------------|---------------|------------------------------|------------|-----------------------------|
| 1,000 | ~$6 | ~$8 | **~$15** | $50–$150 |
| Per lookup | $0.004–$0.012 | $0.004–$0.016 | **~$0.015** | $0.05+ |

Repo already retries MA SOS through this proxy on Imperva **without** solving Turnstile. Same rule here.

---

## 9. First-use cost and runtime (~15,359 companies, mostly CA)

Exact per-state mix is not in this plan (no lead file in git). Working assumption, labeled as such: **~85% CA (~13,050)**, **~15% other (~2,310)**. Recalculate `estimate_only` from the real `source_table` counts before any live run.

Supabase project named for this use: **`azpapwtnrbzywlnxxecz`**. Pool cap **60**. This MCP’s default calling-list project is a **different** id; do not assume they share a pool. Concurrency budget for the job:

| Resource | Cap in code | Why |
|----------|-------------|-----|
| SOS HTTP lanes | 4 (direct) / 1–2 if HTML WAF / Apify conc 2–5 | Under 60; leave room for other writers on the same project |
| Apify Playwright conc | 2–5 | WAF retries dominate cost if higher |
| Supabase writes | **4** (`SUPABASE_WRITE_CONCURRENCY`) | Existing; ~8–12 in-flight with HTTP is plenty of headroom |
| Never | ≥20 client connections | Other jobs on the 60 pool |

Writes are not the bottleneck (15k upserts at 4-wide is minutes). SOS / SI latency is.

### CA (majority)

calicodev developer API is **out**. Search and SI both go through public bizfileOnline. Direct HTTP is free when it works; Incapsula typically forces residential Playwright. Mid model: **~1.5 Apify lookups/row** (search + some SI), **~$0.015**/blocked lookup.

| Scenario | Apify $ | Wall clock | Owner names? |
|----------|---------|------------|--------------|
| Serper-first (5 queries/row, all states) | **$0** Apify; **~$77** Serper for 15,359 | Fast; no WAF | Yes, if high-confidence snippet |
| A. Direct HTTP search + SI (no challenge) | **$0** | ~2–6 h @ 4 lanes | Yes, if SI present |
| B. Typical: Incapsula blocks datacenter; Playwright + residential for search (and SI when images/JSON also block) | **~$290 mid** for ~13,050 (~1.5 × $0.015); range **~$200–$400** | ~20–40 h at conc 3 | Yes, if SI parses |
| C. Worst: two full Playwright runs/row + image SI | **~$400–$750** | longer | Yes, if SI parses |
| D. Josh obtains official weekly bulk with officers | **$0** | Minutes (local join) | Yes |

**Do not scale B until a 50-row probe measures CU** (direct vs Apify hit rate). If D is available, skip B/C.

### Non-CA ~2,310 (order IL → GA → OH → NC → AZ → CO → rest)

| Slice | Expected spend | Runtime |
|-------|----------------|---------|
| IL via official bulk files | $0 | Minutes after one download |
| CO via Socrata | $0 | Minutes; owner yield ~0 |
| OH HTML | $0 if not blocked; else skip Apify | Agent-only |
| GA / NC / AZ HTML | $0 if not blocked | Pace-limited hours |
| GA / NC / AZ Apify (if blocked) | **~$15–$40** mid per 1k blocked | See §8 |
| FL/TX/MA/PA reuse | $0 | Existing pacing |
| DE/WY LLC/OR/IA/WI | $0 | Immediate `no_source` / `agent_only` |

**Planning envelope for the first 15,359 (not a bid):**

- Serper-first (~5 credits/row × 15,359): **~$77** regardless of WAF. Apify only on Serper misses.
- Best (CA weekly bulk **or** unchallenged bizfileOnline + IL files + no Apify): **~$0** Apify + Serper ~$31, under a workday of compute.
- Base (CA Incapsula → Playwright residential, ~1.5 lookups/row, plus a few hundred other blocked HTML rows): **~$200–$400** Apify, dominated by CA, **if Serper misses**.
- Bad (two Playwright runs per CA row + image SI + other blocked states): **~$400–$800** Apify fallback.
- There is no $0 “CA API” line item. Do not sign up for calicodev.

`estimate_only` on the real table should print this envelope with **actual** state counts before anyone enables writes.

---

## 10. What Josh must sign up for

**Do not sign up for** [calicodev.sos.ca.gov](https://calicodev.sos.ca.gov). The Business Entity Search developer API is government-agencies-only. There is no `CA_SOS_API_KEY`.

Required for CA name path at first-use volume:

1. **Serper** `SERPER_API_KEY` on [google.serper.dev](https://google.serper.dev). First owner tier for all 51 jurisdictions. ~5 credits/row (~$0.005).
2. Confirm the existing **Apify** account (`APIFY_TOKEN` / `APIFY_PROXY_PASSWORD`) has **CU + residential GB** headroom as **fallback** when Serper misses and bizfileOnline Incapsula/Imperva blocks datacenter IPs. Playwright + `groups-RESIDENTIAL`. Set `APIFY_MAX_USD`. Starter is enough for a 50-row probe.

Optional, still official, still free or cheap:

3. **CA weekly bulk / SOS data request** — ask whether the free weekly extract includes officer/SI names. If yes, first-use CA is a file join and Apify for CA goes to **$0**.
4. **IL Data Transparency Act files** — download Annual Report + Assumed Names from [ilsos.gov/data/bus-serv-home.html](https://www.ilsos.gov/data/bus-serv-home.html). No key. Do not scrape the search app.

Already in this repo (do not rotate unless `health` says missing): PermitStack, optional Florida Sunbiz Daily `sb_` key, Texas Comptroller, Veriphone.

**Do not sign up for:** calicodev government API, OpenSOSData, SOSfinder, Parse.bot eCorp wrappers, Apify officer-list Actors, CA paid master file, NC/GA/IN paid bulk, Nevada $125 file (unless a later explicit decision).

---

## 11. Phase 1 delivered in this PR

- This plan.
- Catalog of 51 jurisdictions with access mode, officer vs agent, key needs, anti-bot, Apify eligibility.
- Name-path types, fuzzy match (legal + DBA, city tie-break), waterfall field mapper.
- CA BizFile JSON parser + fixture (no live HTTP).
- `lookup_business_owner` / `get_business_owner_job` MCP stubs: estimate + dry job status; **no SOS calls, no writes, no deploy**.
- Tests that the permit router still maps CA → CSLB and CSLB still requires a license number.

## 12. Phase 2 delivered in this PR (still no deploy / no writes)

1. **CA** public bizfileOnline search (`POST /api/Records/businessSearch`) + SI officers from `GET /api/report/GetImageByNum/{documentId}`. Direct HTTP first; Apify Playwright + residential if Incapsula blocks; OCR on PDF/image SI. **No `CA_SOS_API_KEY`.** Never paid datasets.
2. **IL** auto-download DTA zips from `ilsos.gov/data/bs` (or `IL_DTA_DIR`). Empty index → `no_source`. Search UI is never called.
3. **GA / NC** official HTML, Apify fallback if blocked. Challenge pages are never parsed.
4. **AZ** Business Center JSON API via browser/Apify; empty SPA shell is not a match.
5. **OH** JSON entity confirm (`endPoints.json` + `NS_{query}_X`) or `no_source` / `blocked`. Never unverified `agent_only`. **CO** via keyless Socrata `4ykn-tg5h`. No Apify.
6. MCP `lookup_business_owner` batch (`rows[]`, `max_rows` up to 5000), `estimate_only`, `wait`, `get_business_owner_job` status + per-state hit rates + `serper_credits` + `apify_usd_spent`. `APIFY_MAX_USD` hard cap.
7. CLI `scripts/owner_lookup_sample.ts` — CSV in, results CSV + summary JSON (hit rate by state, officer vs agent-only, Serper credits, Apify $). No Supabase.
8. **Serper-first** for all 51 jurisdictions (`SERPER_API_KEY`). High-confidence Google hits skip SOS/Apify. Apify only after a Serper miss on blocked HTML.
9. Unit tests + recorded Cloudflare/Incapsula fixtures. Permit path (`match_state_owners` / CSLB license) stays green.

Still later (not this PR): persist to Email Finder; `source_table` paging; remaining HAVE adapters (FL/TX/MA/PA/NY/WA/MN); optional `match_state_owners` fallback when `no_license_number`.

---

## 13. Sources

- CA public search [bizfileOnline.sos.ca.gov](https://bizfileonline.sos.ca.gov/search/business); [sos.ca.gov business-entities information-requests](https://www.sos.ca.gov/business-programs/business-entities/information-requests). calicodev developer API is government-agencies-only and is not used.
- IL [business entity search](https://apps.ilsos.gov/businessentitysearch/), [terms](https://www.ilsos.gov/privacypolicy.html), [Data Transparency Act files](https://www.ilsos.gov/data/bus-serv-home.html), [File Detail Report field list](https://www.ilsos.gov/departments/business-services/business-searches.html)
- GA [ecorp.sos.ga.gov/businesssearch](https://ecorp.sos.ga.gov/businesssearch)
- OH [businesssearch.ohiosos.gov](https://businesssearch.ohiosos.gov/) (officer gap confirmed against public portal behavior)
- NC SOS business registration search; AZ [arizonabusinesscenter.azcc.gov](https://arizonabusinesscenter.azcc.gov/businesssearch)
- CO [data.colorado.gov 4ykn-tg5h](https://data.colorado.gov/Business/Business-Entities-in-Colorado/4ykn-tg5h); [COinfoMarket](https://www.coloradosos.gov/pubs/info_center/COinfoMarket.html)
- Serper [google.serper.dev](https://google.serper.dev) (~$0.001/search)
- Apify [pricing](https://apify.com/pricing), [CU estimation](https://help.apify.com/en/articles/3470975-how-to-estimate-compute-unit-usage-for-your-project)
- Cross-check (not a substitute for official pages): Forage US registries audit, Oct 2026
