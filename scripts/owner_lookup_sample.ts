#!/usr/bin/env tsx
/**
 * Local name-path probe: CSV in (company, city, state) → results CSV + summary.
 * Does not write to Supabase. Uses env SERPER_API_KEY / APIFY_TOKEN / IL_DTA_DIR.
 * Serper (google.serper.dev) is first for every state; Apify is the blocked-HTML fallback.
 *
 *   npx tsx scripts/owner_lookup_sample.ts --in sample.csv --out results.csv
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultLookupContext } from '../src/server/lib/stateOwners/sos/context.ts';
import {
  formatSampleCsv,
  readCompanyCsv,
  resultToCsvRow,
  summarizeSample,
} from '../src/server/lib/stateOwners/sos/sampleCsv.ts';
import { resolveNameLookup } from '../src/server/lib/stateOwners/sos/namePath.ts';
import { mapPool } from '../src/server/lib/stateOwners/sos/pool.ts';
import { ApifySpendTracker, SerperCreditTracker } from '../src/server/lib/stateOwners/sos/spend.ts';

function arg(flag: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  return fallback;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function printHelp(): void {
  process.stdout.write(`Usage: npx tsx scripts/owner_lookup_sample.ts --in <companies.csv> --out <results.csv>

CSV columns: company (or company_name), city, state

Options:
  --summary <path>     Write summary JSON (default: <out>.summary.json)
  --states CA,IL       Limit to these states
  --concurrency 4      Parallel lookups (default 4, max 8)
  --include-agents     Include registered-agent people (still not waterfall-ready)
  --no-serper          Skip google.serper.dev (default: Serper-first for every state)
  --no-apify           Never call Apify Playwright (fallback only after Serper miss)
  --il-dta-dir <path>  Illinois Data Transparency Act files (or env IL_DTA_DIR)
  --live false         Skip official HTTP (fixture/offline)

Env: SERPER_API_KEY, APIFY_TOKEN, APIFY_MAX_USD, IL_DTA_DIR
No Supabase writes. Permit/license path is unchanged (match_state_owners).
`);
}

async function main(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    return;
  }
  const inPath = arg('--in') || arg('-i');
  const outPath = arg('--out') || arg('-o');
  if (!inPath || !outPath) {
    printHelp();
    process.exitCode = 1;
    return;
  }
  const states = (arg('--states') || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const concurrency = Math.max(1, Math.min(Number(arg('--concurrency', '4')) || 4, 8));
  const live = arg('--live') === 'false' || hasFlag('--offline') ? false : true;
  const spend = new ApifySpendTracker();
  const serper = new SerperCreditTracker();
  const ctx = defaultLookupContext({
    live,
    includeAgents: hasFlag('--include-agents'),
    apifyEnabled: !hasFlag('--no-apify'),
    serperEnabled: !hasFlag('--no-serper'),
    ilDtaDir: arg('--il-dta-dir') || process.env.IL_DTA_DIR || null,
    spend,
    serper,
  });
  const inputRows = await readCompanyCsv(resolve(inPath));
  const filtered = states.length ? inputRows.filter((r) => states.includes(r.state)) : inputRows;
  const lines = await mapPool(filtered, concurrency, async (row) => {
    const result = await resolveNameLookup(row, ctx);
    return resultToCsvRow(row, result);
  });
  const csv = formatSampleCsv(lines);
  const outAbs = resolve(outPath);
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, csv, 'utf8');
  const summary = summarizeSample(lines);
  summary.apify_usd_spent = Number((spend.usd || summary.apify_usd_spent).toFixed(2));
  summary.serper_credits = serper.credits || summary.serper_credits;
  summary.serper_usd = Number((serper.usd || summary.serper_usd).toFixed(4));
  const summaryPath = resolve(arg('--summary') || `${outAbs}.summary.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        in: resolve(inPath),
        out: outAbs,
        summary: summaryPath,
        rows: summary.rows,
        named: summary.named,
        agent_only: summary.agent_only,
        hit_rate: summary.hit_rate,
        hit_rate_by_state: summary.hit_rate_by_state,
        officer_vs_agent: summary.officer_vs_agent,
        apify_usd_spent: summary.apify_usd_spent,
        serper_credits: summary.serper_credits,
        serper_usd: summary.serper_usd,
        via_serper: summary.via_serper,
        writes: false,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write((err instanceof Error ? err.stack || err.message : String(err)) + '\n');
  process.exitCode = 1;
});
