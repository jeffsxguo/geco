#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { loadJson, validateConfig } = require('./config');
const { buildTransferGenerator } = require('./workloads/smallbank');
const { prepareWindowedMergePlan } = require('./window-merge');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonl(filePath, records) {
  const out = records.map((r) => `${JSON.stringify(r)}\n`).join('');
  fs.writeFileSync(filePath, out, 'utf8');
}

function normalizeOriginalRecord(r) {
  return {
    request_id: r.requestId,
    window_index: r.windowIndex,
    function: r.requestSpec?.functionName ?? '',
    args: r.requestSpec?.args ?? [],
    meta: r.requestSpec?.meta ?? {}
  };
}

function normalizeMergedRecord(w) {
  return {
    window_request_id: w.windowRequestId,
    window_index: w.windowIndex ?? null,
    group_index: w.groupIndex ?? null,
    group_count_in_window: w.groupCountInWindow ?? null,
    function: w.mergedSpec?.functionName ?? '',
    args: w.mergedSpec?.args ?? [],
    meta: w.mergedSpec?.meta ?? {}
  };
}

function main() {
  const argv = yargs(hideBin(process.argv))
    .option('config', { type: 'string', demandOption: true, describe: 'Path to JSON config' })
    .option('outputDir', { type: 'string', default: 'results', describe: 'Output directory (relative to tools/abort-rate)' })
    .option('runId', { type: 'string', default: '', describe: 'Optional run ID suffix used in filenames' })
    .strict()
    .parseSync();

  const configPath = path.isAbsolute(argv.config) ? argv.config : path.resolve(process.cwd(), argv.config);
  const config = loadJson(configPath);
  validateConfig(config);

  if (!config.driver?.window || config.driver.window.type !== 'count') {
    throw new Error('dump-merge-plan requires driver.window.type="count"');
  }
  if (!config.driver?.windowMerge?.type) {
    throw new Error('dump-merge-plan requires driver.windowMerge.type to be set (e.g., "ctm")');
  }

  if (config.workload?.name !== 'smallbank_transfer') {
    if (config.workload?.name !== 'bookkeeping_tx' && config.workload?.name !== 'stock_trade') {
      throw new Error(`Unsupported workload: ${config.workload?.name}`);
    }
  }

  let generator;
  if (config.workload.name === 'smallbank_transfer') {
    generator = buildTransferGenerator({
      numAccounts: config.workload.numAccounts,
      hotAccountFraction: config.scenario.hotAccountFraction,
      conflictRatio: config.scenario.conflictRatio,
      seed: config.scenario.seed,
      amountSpec: config.workload.amount,
      scenarioName: config.scenario.name
    });
  } else if (config.workload.name === 'bookkeeping_tx') {
    const { buildBookkeepingGenerator } = require('./workloads/bookkeeping');
    generator = buildBookkeepingGenerator({
      numAccounts: config.workload.numAccounts,
      hotAccountFraction: config.scenario.hotAccountFraction,
      conflictRatio: config.scenario.conflictRatio,
      seed: config.scenario.seed,
      deltaSpec: config.workload.amount,
      scenarioName: config.scenario.name
    });
  } else if (config.workload.name === 'stock_trade') {
    const { buildStockTradeGenerator } = require('./workloads/stock');
    generator = buildStockTradeGenerator({
      numAccounts: config.workload.numAccounts,
      hotAccountFraction: config.scenario.hotAccountFraction,
      conflictRatio: config.scenario.conflictRatio,
      seed: config.scenario.seed,
      scenarioName: config.scenario.name
    });
  }

  const plan = prepareWindowedMergePlan({
    totalRequests: config.driver.totalRequests,
    makeRequest: (ctx) => generator.nextRequest(ctx),
    windowSpec: config.driver.window,
    mergeType: config.driver.windowMerge.type,
    requestIdPrefix: 'req'
  });

  const outDir = path.isAbsolute(argv.outputDir)
    ? argv.outputDir
    : path.resolve(process.cwd(), argv.outputDir);
  ensureDir(outDir);

  const suffixParts = [
    config.system ?? 'system',
    `merge_${config.driver.windowMerge.type}`,
    `w_${config.driver.window.size}`,
    `n_${config.driver.totalRequests}`,
    `cr_${config.scenario.conflictRatio}`,
    argv.runId ? String(argv.runId) : ''
  ].filter(Boolean);
  const suffix = suffixParts.join('.');

  const originalPath = path.join(outDir, `merge-plan.${suffix}.original.jsonl`);
  const mergedPath = path.join(outDir, `merge-plan.${suffix}.merged.jsonl`);
  const reversePath = path.join(outDir, `merge-plan.${suffix}.orig-to-merged.jsonl`);
  const mdPath = path.join(outDir, `merge-plan.${suffix}.summary.md`);

  const originalRecords = plan.originalRequests.map(normalizeOriginalRecord);
  const mergedRecords = plan.windowRequests.map(normalizeMergedRecord);

  // Reverse mapping: original request_id -> list of merged window_request_id(s)
  const origToMerged = new Map();
  for (const w of plan.windowRequests) {
    const ids = w?.mergedSpec?.meta?.original_tx_ids;
    const mergedId = w.windowRequestId;
    if (Array.isArray(ids) && ids.length > 0) {
      for (const oid of ids) {
        if (!origToMerged.has(oid)) origToMerged.set(oid, []);
        origToMerged.get(oid).push(mergedId);
      }
    } else {
      // For non-provenance modes, fall back to subrequest_ids.
      const subIds = w?.mergedSpec?.meta?.subrequest_ids;
      if (Array.isArray(subIds)) {
        for (const oid of subIds) {
          if (!origToMerged.has(oid)) origToMerged.set(oid, []);
          origToMerged.get(oid).push(mergedId);
        }
      }
    }
  }

  const reverseRecords = [];
  const allOrigIds = originalRecords.map((r) => r.request_id).sort();
  for (const oid of allOrigIds) {
    const mergedIds = (origToMerged.get(oid) ?? []).slice().sort();
    reverseRecords.push({ request_id: oid, merged_window_request_ids: mergedIds });
  }

  writeJsonl(originalPath, originalRecords);
  writeJsonl(mergedPath, mergedRecords);
  writeJsonl(reversePath, reverseRecords);

  // Markdown summary for quick review.
  const mergedTotal = mergedRecords.length;
  const windows = new Set(originalRecords.map((r) => r.window_index)).size;
  const groupCounts = new Map(); // window_index -> group_count
  for (const rec of mergedRecords) {
    const w = rec.window_index;
    const gCount = rec.group_count_in_window;
    if (Number.isInteger(w) && Number.isInteger(gCount)) groupCounts.set(w, gCount);
  }
  const groupCountValues = Array.from(groupCounts.values());
  groupCountValues.sort((a, b) => a - b);

  const md = [];
  md.push(`# Merge Plan Dump`);
  md.push('');
  md.push(`- config: \`${path.relative(process.cwd(), configPath)}\``);
  md.push(`- system: \`${config.system}\``);
  md.push(`- merge_type: \`${config.driver.windowMerge.type}\``);
  md.push(`- total_original_requests: \`${config.driver.totalRequests}\``);
  md.push(`- window_size: \`${config.driver.window.size}\` (count windows: \`${windows}\`)`);
  md.push(`- total_merged_requests: \`${mergedTotal}\``);
  md.push('');
  md.push(`## Files`);
  md.push('');
  md.push(`- original: \`${path.relative(process.cwd(), originalPath)}\``);
  md.push(`- merged: \`${path.relative(process.cwd(), mergedPath)}\``);
  md.push(`- orig->merged: \`${path.relative(process.cwd(), reversePath)}\``);
  md.push('');
  md.push(`## Notes`);
  md.push('');
  md.push(`- Each line in the JSONL files is a single record you can grep/sort/filter.`);
  md.push(`- For CTM, merged records include \`meta.original_tx_ids\` (provenance) and \`meta.original_tx_count_unique\`.`);
  md.push(`- \`orig-to-merged\` shows which merged tx IDs each original tx participates in.`);
  md.push('');

  fs.writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8');

  process.stdout.write(`original=${originalPath}\n`);
  process.stdout.write(`merged=${mergedPath}\n`);
  process.stdout.write(`orig_to_merged=${reversePath}\n`);
  process.stdout.write(`summary_md=${mdPath}\n`);
}

main();
