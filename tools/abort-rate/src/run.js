const path = require('node:path');
const fs = require('node:fs');

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { v4: uuidv4 } = require('uuid');

const { loadJson, validateConfig } = require('./config');
const { createJsonlWriter, ensureDir } = require('./log');
const { connectFabricGateway } = require('./fabric');
const { classifyFabricError, classifyCommitStatus } = require('./classify');
const { runClosedLoop } = require('./runner');
const { summarizeJsonl, appendSummaryCsv } = require('./summarize');
const { buildTransferGenerator } = require('./workloads/smallbank');
const { buildBookkeepingGenerator } = require('./workloads/bookkeeping');
const { buildStockTradeGenerator } = require('./workloads/stock');
const { prepareWindowedMergePlan } = require('./window-merge');

function parseProfilingPayload(resultBytes) {
  if (!resultBytes || resultBytes.length === 0) return null;
  let text = '';
  try {
    text = Buffer.from(resultBytes).toString('utf8');
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function submitOnce(contract, functionName, args) {
  const proposal = contract.newProposal(functionName, { arguments: args });
  const txId =
    (typeof proposal.getTransactionId === 'function' && proposal.getTransactionId()) ||
    proposal.transactionId ||
    '';

  const endorseStartMs = Date.now();
  const endorsed = await proposal.endorse();
  const endorseEndMs = Date.now();

  const resultBytes = typeof endorsed.getResult === 'function' ? endorsed.getResult() : null;
  const payload = parseProfilingPayload(resultBytes);
  const pEncodeMs = Number.isFinite(payload?.p_encode_ms) ? Number(payload.p_encode_ms) : 0;
  const pEncryptMs = Number.isFinite(payload?.p_encrypt_ms) ? Number(payload.p_encrypt_ms) : 0;

  const submitStartMs = Date.now();
  const submitted = await endorsed.submit();
  const submitEndMs = Date.now();

  const commitStartMs = Date.now();
  const status = await submitted.getStatus();
  const commitEndMs = Date.now();

  return {
    txId,
    status,
    timings: {
      endorse_ms: endorseEndMs - endorseStartMs,
      submit_ms: submitEndMs - submitStartMs,
      commit_ms: commitEndMs - commitStartMs,
      p_encode_ms: pEncodeMs
    }
  };
}

function buildWorkloadGenerator(config) {
  const scenarioName = config.scenario.name;
  if (config.workload.name === 'smallbank_transfer') {
    return buildTransferGenerator({
      numAccounts: config.workload.numAccounts,
      hotAccountFraction: config.scenario.hotAccountFraction,
      conflictRatio: config.scenario.conflictRatio,
      seed: config.scenario.seed,
      amountSpec: config.workload.amount,
      scenarioName,
      functionName: 'Transfer'
    });
  }

  if (config.workload.name === 'smallbank_transfer_fhe') {
    return buildTransferGenerator({
      numAccounts: config.workload.numAccounts,
      hotAccountFraction: config.scenario.hotAccountFraction,
      conflictRatio: config.scenario.conflictRatio,
      seed: config.scenario.seed,
      amountSpec: config.workload.amount,
      scenarioName,
      functionName: 'TransferFHE'
    });
  }
  if (config.workload.name === 'smallbank_transfer_fhe_zeestar') {
    return buildTransferGenerator({
      numAccounts: config.workload.numAccounts,
      hotAccountFraction: config.scenario.hotAccountFraction,
      conflictRatio: config.scenario.conflictRatio,
      seed: config.scenario.seed,
      amountSpec: config.workload.amount,
      scenarioName,
      functionName: 'TransferFHECipher'
    });
  }

  if (config.workload.name === 'bookkeeping_tx') {
    return buildBookkeepingGenerator({
      numAccounts: config.workload.numAccounts,
      hotAccountFraction: config.scenario.hotAccountFraction,
      conflictRatio: config.scenario.conflictRatio,
      seed: config.scenario.seed,
      deltaSpec: config.workload.amount,
      scenarioName
    });
  }

  if (config.workload.name === 'stock_trade') {
    return buildStockTradeGenerator({
      numAccounts: config.workload.numAccounts,
      hotAccountFraction: config.scenario.hotAccountFraction,
      conflictRatio: config.scenario.conflictRatio,
      seed: config.scenario.seed,
      scenarioName
    });
  }

  throw new Error(`Unsupported workload: ${config.workload.name}`);
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('config', { type: 'string', demandOption: true, describe: 'Path to JSON config' })
    .strict()
    .parseSync();

  const config = loadJson(argv.config);
  validateConfig(config);

  const runId = config.runId && String(config.runId).trim().length > 0 ? String(config.runId) : uuidv4();
  const outputDir = path.isAbsolute(config.outputDir) ? config.outputDir : path.resolve(process.cwd(), config.outputDir);
  ensureDir(outputDir);

  const writer = createJsonlWriter(outputDir, runId);

  const meta = {
    run_id: runId,
    system: config.system,
    workload: config.workload.name,
    scenario: config.scenario.name,
    conflict_ratio: config.scenario.conflictRatio,
    seed: config.scenario.seed ?? 0,
    concurrency: config.driver.concurrency,
    total_requests: config.driver.totalRequests,
    window: config.driver.window ?? null,
    window_merge: config.driver.windowMerge?.type ?? 'none'
  };

  writer.write({ type: 'run_meta', ...meta, config });

  const workloadGenerator = buildWorkloadGenerator(config);

  const gateway = await connectFabricGateway(config.fabric, {
    endorseTimeoutMs: config.driver.attemptTimeoutMs,
    submitTimeoutMs: config.driver.attemptTimeoutMs,
    commitStatusTimeoutMs: config.driver.attemptTimeoutMs
  });

  const contract = gateway.contract;

  async function submitAttempt({ requestId, attemptId, workerId, requestSpec }) {
    try {
      const { txId, status, timings } = await submitOnce(contract, requestSpec.functionName, requestSpec.args);
      const classified = classifyCommitStatus(status);

      const successful =
        status && (status.successful === true || status.code === 0 || String(status.code).toUpperCase().includes('VALID'));

      const mergeMs = Number.isFinite(requestSpec?.meta?.p_merge_ms) ? Number(requestSpec.meta.p_merge_ms) : 0;
      const encodeMs = Number.isFinite(timings?.p_encode_ms) ? timings.p_encode_ms : 0;
      const encryptMs = Number.isFinite(timings?.p_encrypt_ms) ? timings.p_encrypt_ms : 0;
      const pMs = mergeMs + encodeMs + encryptMs;
      const endorseMs = Number.isFinite(timings?.endorse_ms) ? timings.endorse_ms : null;
      const eMs = Number.isFinite(endorseMs) ? Math.max(0, endorseMs - encodeMs - encryptMs) : null;
      const oMs = Number.isFinite(timings?.submit_ms) ? timings.submit_ms : null;
      const vMs = Number.isFinite(timings?.commit_ms) ? timings.commit_ms : null;

      if (successful) {
        return {
          outcome: 'commit',
          txId,
          fabricStatus: classified.fabricStatus,
          p_ms: pMs,
          e_ms: eMs,
          o_ms: oMs,
          v_ms: vMs,
          p_encode_ms: encodeMs,
          p_encrypt_ms: encryptMs,
          p_merge_ms: mergeMs,
          endorse_ms: endorseMs,
          submit_ms: oMs,
          commit_ms: vMs
        };
      }

      return {
        outcome: 'abort',
        txId,
        abortReason: classified.abortReason || 'abort_unknown',
        fabricStatus: classified.fabricStatus || '',
        p_ms: pMs,
        e_ms: eMs,
        o_ms: oMs,
        v_ms: vMs,
        p_encode_ms: encodeMs,
        p_encrypt_ms: encryptMs,
        p_merge_ms: mergeMs,
        endorse_ms: endorseMs,
        submit_ms: oMs,
        commit_ms: vMs
      };
    } catch (error) {
      const classified = classifyFabricError(error);
      return {
        outcome: 'abort',
        abortReason: classified.abortReason,
        fabricStatus: classified.fabricStatus,
        txId: '',
        error_message: error?.message || String(error)
      };
    }
  }

  const requestSummaries = [];

  if (config.driver.windowMerge?.type) {
    const plan = prepareWindowedMergePlan({
      totalRequests: config.driver.totalRequests,
      makeRequest: (ctx) => workloadGenerator.nextRequest(ctx),
      windowSpec: config.driver.window,
      mergeType: config.driver.windowMerge.type,
      requestIdPrefix: 'req'
    });

    const windowById = new Map(plan.windowRequests.map((w) => [w.windowRequestId, w]));

    writer.write({
      type: 'window_merge_plan',
      ...meta,
      window_size: plan.windowSize,
      window_count: plan.windowRequests.length,
      merge_type: plan.mergeType
    });

    await runClosedLoop({
      totalRequests: plan.windowRequests.length,
      concurrency: config.driver.concurrency,
      requestTimeoutMs: config.driver.requestTimeoutMs,
      maxAttemptsPerRequest: config.driver.maxAttemptsPerRequest,
      backoffSpec: config.driver.backoffMs,
      windowSpec: null,
      formatRequestId: (windowRequestIndex) => plan.windowRequests[windowRequestIndex].windowRequestId,
      makeRequest: ({ requestIndex }) => plan.windowRequests[requestIndex].mergedSpec,
      submitAttempt,
      onAttemptRecord: (record) => writer.write({ ...meta, ...record }),
      onRequestDone: (windowSummary) => {
        const w = windowById.get(windowSummary.request_id);
        writer.write({
          ...meta,
          type: 'window_summary',
          window_index: w?.windowIndex ?? null,
          window_request_id: windowSummary.request_id,
          group_index: w?.groupIndex ?? null,
          group_count_in_window: w?.groupCountInWindow ?? null,
          committed: windowSummary.committed,
          attempts: windowSummary.attempts,
          abort_reason: windowSummary.abort_reason,
          start_ts_ms: windowSummary.start_ts_ms,
          end_ts_ms: windowSummary.end_ts_ms,
          latency_ms: windowSummary.latency_ms
        });

        // For window-merge modes that rewrite transactions into multiple `Transfer()` calls,
        // the derived window_request_id is the correct unit for request-level accounting.
        const derivedSummary = {
          type: 'request_summary',
          request_id: windowSummary.request_id,
          committed: windowSummary.committed,
          attempts: windowSummary.attempts,
          abort_reason: windowSummary.committed ? '' : (windowSummary.abort_reason ?? ''),
          start_ts_ms: windowSummary.start_ts_ms,
          end_ts_ms: windowSummary.end_ts_ms,
          latency_ms: windowSummary.latency_ms,
          window_request_id: windowSummary.request_id,
          window_index: w?.windowIndex ?? null
        };
        requestSummaries.push(derivedSummary);
        writer.write({ ...meta, ...derivedSummary });
      }
    });
  } else {
    await runClosedLoop({
      totalRequests: config.driver.totalRequests,
      concurrency: config.driver.concurrency,
      requestTimeoutMs: config.driver.requestTimeoutMs,
      maxAttemptsPerRequest: config.driver.maxAttemptsPerRequest,
      backoffSpec: config.driver.backoffMs,
      windowSpec: config.driver.window,
      makeRequest: (ctx) => workloadGenerator.nextRequest(ctx),
      submitAttempt,
      onAttemptRecord: (record) => writer.write({ ...meta, ...record }),
      onRequestDone: (summary) => {
        requestSummaries.push(summary);
        writer.write({ ...meta, ...summary });
      }
    });
  }

  await gateway.close();
  await writer.close();

  const summary = await summarizeJsonl(writer.jsonlPath);
  const summaryPath = path.join(outputDir, `${runId}.summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify({ run_id: runId, meta, summary }, null, 2), 'utf8');

  appendSummaryCsv(outputDir, runId, {
    system: config.system,
    workload: config.workload.name,
    scenario: config.scenario.name,
    conflictRatio: config.scenario.conflictRatio,
    concurrency: config.driver.concurrency,
    totalRequests: config.driver.totalRequests
  }, summary);

  process.stdout.write(`run_id=${runId}\n`);
  process.stdout.write(`jsonl=${writer.jsonlPath}\n`);
  process.stdout.write(`summary=${summaryPath}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e?.message || String(e)}\n`);
  process.exit(1);
});
