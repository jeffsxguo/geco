const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function percentile(sortedNumbers, p) {
  if (sortedNumbers.length === 0) return null;
  const idx = Math.ceil((p / 100) * sortedNumbers.length) - 1;
  return sortedNumbers[Math.min(Math.max(idx, 0), sortedNumbers.length - 1)];
}

function percentileSummary(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99)
  };
}

async function summarizeJsonl(jsonlPath) {
  let runMeta = null;
  let attemptsTotal = 0;
  let attemptsCommitted = 0;
  let attemptsAborted = 0;
  const abortReasons = {};

  const requestAttempts = new Map();
  let requestsTotal = 0;
  let requestsFailed = 0;

  // For computing "no retry" and "abort events per original request".
  const attemptAbortCountByRequestId = new Map(); // request_id -> #abort attempts
  const firstAttemptOutcomeByRequestId = new Map(); // request_id -> 'commit'|'abort'

  const requestKeys = [];
  let practicalAbortedOriginalEquiv = 0;
  let practicalAbortedMergedRequests = 0;
  let practicalMergedRequests = 0;
  let abortEventsOriginalEquiv = 0;
  const stageSamples = {
    p_ms: [],
    e_ms: [],
    o_ms: [],
    v_ms: []
  };
  const stageTotals = {
    p_ms: 0,
    e_ms: 0,
    o_ms: 0,
    v_ms: 0
  };
  let stageCount = 0;
  const totalLatencySamples = [];
  let totalLatencySum = 0;

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line) return;
      const rec = JSON.parse(line);
      if (rec.type === 'run_meta' && !runMeta) runMeta = rec;
      if (rec.type === 'attempt') {
        attemptsTotal += 1;
        if (rec.outcome === 'commit') attemptsCommitted += 1;
        else {
          attemptsAborted += 1;
          const r = rec.abort_reason || 'abort_unknown';
          abortReasons[r] = (abortReasons[r] ?? 0) + 1;
        }
        if (rec.outcome === 'commit') {
          if (Number.isFinite(rec.p_ms)) stageSamples.p_ms.push(rec.p_ms);
          if (Number.isFinite(rec.e_ms)) stageSamples.e_ms.push(rec.e_ms);
          if (Number.isFinite(rec.o_ms)) stageSamples.o_ms.push(rec.o_ms);
          if (Number.isFinite(rec.v_ms)) stageSamples.v_ms.push(rec.v_ms);
          if (
            Number.isFinite(rec.p_ms) &&
            Number.isFinite(rec.e_ms) &&
            Number.isFinite(rec.o_ms) &&
            Number.isFinite(rec.v_ms)
          ) {
            stageTotals.p_ms += rec.p_ms;
            stageTotals.e_ms += rec.e_ms;
            stageTotals.o_ms += rec.o_ms;
            stageTotals.v_ms += rec.v_ms;
            stageCount += 1;
          }
          if (Number.isFinite(rec.latency_ms)) {
            totalLatencySamples.push(rec.latency_ms);
            totalLatencySum += rec.latency_ms;
          }
        }

        const rid = rec.request_id;
        if (rid) {
          if (rec.outcome !== 'commit') {
            attemptAbortCountByRequestId.set(rid, (attemptAbortCountByRequestId.get(rid) ?? 0) + 1);
          }
          if (rec.attempt_id === 1 && !firstAttemptOutcomeByRequestId.has(rid)) {
            firstAttemptOutcomeByRequestId.set(rid, rec.outcome === 'commit' ? 'commit' : 'abort');
          }
        }

        if (rec.outcome !== 'commit') {
          const w = Number(rec?.meta?.original_tx_count_unique);
          abortEventsOriginalEquiv += Number.isFinite(w) && w > 0 ? w : 1;
        }

        if (rec.attempt_id === 1) {
          practicalMergedRequests += 1;
          if (rec.outcome !== 'commit') {
            practicalAbortedMergedRequests += 1;
            const mergeType = String(rec?.meta?.merge_type ?? '');
            const c = mergeType && mergeType !== 'ctm'
              ? Number(rec?.meta?.original_tx_count_unique ?? rec?.meta?.original_equiv_count ?? rec?.meta?.subrequest_count)
              : Number(rec?.meta?.original_equiv_count ?? rec?.meta?.subrequest_count);
            practicalAbortedOriginalEquiv += Number.isFinite(c) && c > 0 ? c : 1;
          }
        }
      }

      if (rec.type === 'request_summary') {
        requestsTotal += 1;
        requestAttempts.set(rec.request_id, rec.attempts ?? 0);
        if (!rec.committed) requestsFailed += 1;
        requestKeys.push(rec.window_request_id || rec.request_id);
      }
    });

    rl.on('close', resolve);
    rl.on('error', reject);
    stream.on('error', reject);
  });

  const attemptAbortRate = attemptsTotal === 0 ? null : attemptsAborted / attemptsTotal;
  const requestAbortProb = requestsTotal === 0 ? null : requestsFailed / requestsTotal;

  const attemptCounts = Array.from(requestAttempts.values()).sort((a, b) => a - b);
  const retrySummary = {
    p50: percentile(attemptCounts, 50),
    p90: percentile(attemptCounts, 90),
    p99: percentile(attemptCounts, 99),
    max: attemptCounts.length === 0 ? null : attemptCounts[attemptCounts.length - 1]
  };

  // "Original request" metrics:
  // - no_retry_abort_rate: counts whether the first attempt aborts (baseline: per request_id; CTM: per window_request_id)
  // - with_retry_abort_events_per_request: counts total abort attempts, normalized by original request count (can exceed 1.0)
  let originalTotal = 0;
  let originalAbortedNoRetry = 0;
  let originalAbortEvents = 0;

  for (const key of requestKeys) {
    originalTotal += 1;
    const firstOutcome = firstAttemptOutcomeByRequestId.get(key);
    if (firstOutcome === 'abort') originalAbortedNoRetry += 1;
    const abortEvents = attemptAbortCountByRequestId.get(key) ?? 0;
    originalAbortEvents += abortEvents;
  }

  const originalNoRetryRate = originalTotal === 0 ? null : originalAbortedNoRetry / originalTotal;
  const originalAbortEventsPerRequest = originalTotal === 0 ? null : originalAbortEvents / originalTotal;

  // Practical no-retry abort metric:
  // - denominator: original request count (from run_meta.total_requests if available, else requestsTotal)
  // - numerator:
  //   - baseline: count aborted first-attempt requests (1 per abort)
  //   - merged requests: count aborted original-equivalent using meta.subrequest_count (e.g., CTM group size)
  let practicalDenom = Number(runMeta?.total_requests);
  if (!Number.isFinite(practicalDenom) || practicalDenom <= 0) practicalDenom = requestsTotal;

  // practicalAbort* computed during stream

  const practicalAbortRate =
    !Number.isFinite(practicalDenom) || practicalDenom === 0 ? null : practicalAbortedOriginalEquiv / practicalDenom;
  const mergedAbortRate =
    practicalMergedRequests === 0 ? null : practicalAbortedMergedRequests / practicalMergedRequests;

  // Retry-aware abort events:
  // Count total abort attempts (events), but normalize in "original tx units":
  // - baseline: each attempt corresponds to 1 original tx
  // - CTM: each merged tx attempt carries `meta.original_tx_count_unique` (provenance size)
  // abortEventsOriginalEquiv computed during stream
  const abortEventsPerOriginal =
    !Number.isFinite(practicalDenom) || practicalDenom === 0 ? null : abortEventsOriginalEquiv / practicalDenom;

  return {
    meta: {
      original_total_requests: practicalDenom
    },
    stages: {
      p_ms: percentileSummary(stageSamples.p_ms),
      e_ms: percentileSummary(stageSamples.e_ms),
      o_ms: percentileSummary(stageSamples.o_ms),
      v_ms: percentileSummary(stageSamples.v_ms),
      averages: {
        p_ms: stageCount ? stageTotals.p_ms / stageCount : null,
        e_ms: stageCount ? stageTotals.e_ms / stageCount : null,
        o_ms: stageCount ? stageTotals.o_ms / stageCount : null,
        v_ms: stageCount ? stageTotals.v_ms / stageCount : null
      }
    },
    total_latency_ms: {
      avg: totalLatencySamples.length ? totalLatencySum / totalLatencySamples.length : null,
      p99: percentile(totalLatencySamples.slice().sort((a, b) => a - b), 99)
    },
    attempts: {
      total: attemptsTotal,
      committed: attemptsCommitted,
      aborted: attemptsAborted,
      abort_rate_attempt: attemptAbortRate,
      abort_reasons: abortReasons
    },
    requests: {
      total: requestsTotal,
      failed: requestsFailed,
      abort_prob_request: requestAbortProb,
      retry_attempts: retrySummary
    },
    original: {
      total: originalTotal,
      no_retry: {
        aborted: originalAbortedNoRetry,
        abort_rate: originalNoRetryRate
      },
      with_retry: {
        abort_events: originalAbortEvents,
        abort_events_per_request: originalAbortEventsPerRequest
      }
    },
    practical_no_retry: {
      aborted_original_equiv: practicalAbortedOriginalEquiv,
      abort_rate: practicalAbortRate,
      merged_requests: practicalMergedRequests,
      merged_requests_aborted: practicalAbortedMergedRequests,
      merged_abort_rate: mergedAbortRate
    },
    practical_with_retry: {
      abort_events_original_equiv: abortEventsOriginalEquiv,
      abort_events_per_original: abortEventsPerOriginal
    }
  };
}

function toCsvRow(summary) {
  const flatten = {
    attempts_total: summary.attempts.total,
    attempts_committed: summary.attempts.committed,
    attempts_aborted: summary.attempts.aborted,
    abort_rate_attempt: summary.attempts.abort_rate_attempt,
    requests_total: summary.requests.total,
    requests_failed: summary.requests.failed,
    abort_prob_request: summary.requests.abort_prob_request,
    retry_p50: summary.requests.retry_attempts.p50,
    retry_p90: summary.requests.retry_attempts.p90,
    retry_p99: summary.requests.retry_attempts.p99,
    retry_max: summary.requests.retry_attempts.max
  };

  const keys = Object.keys(flatten);
  const values = keys.map((k) => {
    const v = flatten[k];
    if (v === null || v === undefined) return '';
    return String(v);
  });
  return { keys, values };
}

function appendSummaryCsv(outputDir, runId, meta, summary) {
  const csvPath = path.join(outputDir, 'summary.csv');
  const { keys, values } = toCsvRow(summary);

  const metaFlat = {
    run_id: runId,
    system: meta.system,
    workload: meta.workload,
    scenario: meta.scenario,
    conflict_ratio: meta.conflictRatio,
    concurrency: meta.concurrency,
    total_requests: meta.totalRequests
  };

  const metaKeys = Object.keys(metaFlat);
  const allKeys = [...metaKeys, ...keys];
  const allValues = [...metaKeys.map((k) => String(metaFlat[k] ?? '')), ...values];

  const exists = fs.existsSync(csvPath);
  const header = `${allKeys.join(',')}\n`;
  const row = `${allValues.join(',')}\n`;

  if (!exists) fs.writeFileSync(csvPath, header, 'utf8');
  fs.appendFileSync(csvPath, row, 'utf8');
}

module.exports = { summarizeJsonl, appendSummaryCsv };
