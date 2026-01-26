#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

function readJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

function indexByKey(records, keyField) {
  const m = new Map();
  for (const r of records) {
    const k = r?.[keyField];
    if (k) m.set(k, r);
  }
  return m;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('merged', { type: 'string', demandOption: true, describe: 'Path to merged.jsonl' })
    .option('original', { type: 'string', demandOption: true, describe: 'Path to original.jsonl' })
    .option('id', { type: 'string', demandOption: true, describe: 'window_request_id to inspect' })
    .strict()
    .parseSync();

  const mergedPath = path.resolve(process.cwd(), argv.merged);
  const originalPath = path.resolve(process.cwd(), argv.original);

  const mergedRecords = readJsonl(mergedPath);
  const originalRecords = readJsonl(originalPath);
  const originalById = indexByKey(originalRecords, 'request_id');

  const rec = mergedRecords.find((r) => r.window_request_id === argv.id);
  if (!rec) {
    throw new Error(`merged record not found for window_request_id=${argv.id}`);
  }

  const meta = rec.meta ?? {};
  const origIds = Array.isArray(meta.original_tx_ids) ? meta.original_tx_ids : [];

  process.stdout.write(`Merged tx: ${rec.window_request_id}\n`);
  process.stdout.write(`- function: ${rec.function}\n`);
  process.stdout.write(`- args: ${JSON.stringify(rec.args)}\n`);
  process.stdout.write(`- window_index=${rec.window_index} group_index=${rec.group_index} tx_index=${meta.tx_index}\n`);
  process.stdout.write(`- original_tx_count_unique=${meta.original_tx_count_unique}\n`);
  process.stdout.write(`- original_tx_ids (${origIds.length}): ${JSON.stringify(origIds)}\n`);
  process.stdout.write('\n');

  if (origIds.length === 0) {
    process.stdout.write('No provenance (meta.original_tx_ids) found for this merged tx.\n');
    return;
  }

  process.stdout.write('Original tx details (in provenance order):\n');
  for (const oid of origIds) {
    const o = originalById.get(oid);
    if (!o) {
      process.stdout.write(`- ${oid}: (not found in original.jsonl)\n`);
      continue;
    }
    process.stdout.write(`- ${oid}: ${o.function} ${JSON.stringify(o.args)} meta=${JSON.stringify(o.meta)}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e?.message || String(e)}\n`);
  process.exit(1);
});
