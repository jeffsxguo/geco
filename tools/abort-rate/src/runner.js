const { nowMs, sleepMs } = require('./time');

function normalizeBackoffSpec(backoffSpec) {
  if (!backoffSpec || backoffSpec.type === 'fixed') {
    return async () => sleepMs(Number(backoffSpec?.value ?? 0));
  }

  if (backoffSpec.type === 'exponential') {
    const baseMs = Number(backoffSpec.baseMs ?? 10);
    const maxMs = Number(backoffSpec.maxMs ?? 2000);
    return async (attemptIndex) => {
      const ms = Math.min(maxMs, baseMs * 2 ** attemptIndex);
      return sleepMs(ms);
    };
  }

  return async () => {};
}

function computeWindowIndex({ windowSpec, requestIndex, requestStartMs, runStartMs }) {
  if (!windowSpec) return null;

  if (windowSpec.type === 'count') {
    const size = Number(windowSpec.size ?? 0);
    if (!Number.isFinite(size) || size <= 0) return null;
    return Math.floor(requestIndex / size);
  }

  if (windowSpec.type === 'time') {
    const ms = Number(windowSpec.ms ?? 0);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const origin = Number.isFinite(runStartMs) ? runStartMs : requestStartMs;
    return Math.floor((requestStartMs - origin) / ms);
  }

  return null;
}

function sanitizeArgs(args) {
  if (!Array.isArray(args)) return args;
  return args.map((arg) => {
    if (typeof arg !== 'string') return arg;
    if (arg.length <= 256) return arg;
    return `${arg.slice(0, 64)}...(${arg.length} chars)`;
  });
}

async function runClosedLoop({
  totalRequests,
  concurrency,
  requestTimeoutMs,
  maxAttemptsPerRequest,
  backoffSpec,
  windowSpec,
  formatRequestId,
  makeRequest,
  submitAttempt,
  onAttemptRecord,
  onRequestDone
}) {
  const startMs = nowMs();
  let nextRequestIndex = 0;

  const attemptsPerRequest = new Map();

  const backoff = normalizeBackoffSpec(backoffSpec);
  const maxAttemptsNumber = Number(maxAttemptsPerRequest);
  const unlimitedAttempts = !Number.isFinite(maxAttemptsNumber) || maxAttemptsNumber <= 0;

  async function worker(workerId) {
    while (true) {
      const requestIndex = nextRequestIndex;
      nextRequestIndex += 1;
      if (requestIndex >= totalRequests) return;

      const requestId = typeof formatRequestId === 'function'
        ? formatRequestId(requestIndex)
        : `req_${String(requestIndex).padStart(8, '0')}`;
      const requestStartMs = nowMs();
      const windowIndex = computeWindowIndex({
        windowSpec,
        requestIndex,
        requestStartMs,
        runStartMs: startMs
      });

      const baseRequestContext = {
        requestIndex,
        requestId,
        workerId,
        requestStartMs,
        windowIndex
      };

      // Generate request spec once per request so retries re-submit the same logical request.
      const requestSpec = makeRequest(baseRequestContext);

      let committed = false;
      let attemptId = 0;
      let lastAbortReason = '';

      while (!committed && (unlimitedAttempts || attemptId < maxAttemptsNumber)) {
        attemptId += 1;
        attemptsPerRequest.set(requestId, attemptId);

        const attemptStartMs = nowMs();

        const result = await submitAttempt({
          requestId,
          attemptId,
          workerId,
          requestSpec
        });

        const attemptEndMs = nowMs();
        const record = {
          type: 'attempt',
          request_id: requestId,
          attempt_id: attemptId,
          worker_id: workerId,
          submit_ts_ms: attemptStartMs,
          decision_ts_ms: attemptEndMs,
          latency_ms: attemptEndMs - attemptStartMs,
          outcome: result.outcome,
          abort_reason: result.abortReason ?? '',
          fabric_status: result.fabricStatus ?? '',
          tx_id: result.txId ?? '',
          error_message: result.error_message ?? '',
          function: requestSpec.functionName,
          args: sanitizeArgs(requestSpec.args),
          meta: requestSpec.meta ?? {},
          p_ms: result.p_ms ?? null,
          e_ms: result.e_ms ?? null,
          o_ms: result.o_ms ?? null,
          v_ms: result.v_ms ?? null,
          p_encode_ms: result.p_encode_ms ?? null,
          p_encrypt_ms: result.p_encrypt_ms ?? null,
          p_merge_ms: result.p_merge_ms ?? null,
          endorse_ms: result.endorse_ms ?? null,
          submit_ms: result.submit_ms ?? null,
          commit_ms: result.commit_ms ?? null
        };

        onAttemptRecord(record);

        if (result.outcome === 'commit') {
          committed = true;
          break;
        }

        lastAbortReason = result.abortReason ?? 'abort_unknown';

        const elapsed = nowMs() - requestStartMs;
        if (requestTimeoutMs && elapsed > requestTimeoutMs) break;

        await backoff(attemptId - 1);
      }

      const requestEndMs = nowMs();
      onRequestDone({
        type: 'request_summary',
        request_id: requestId,
        committed,
        attempts: attemptsPerRequest.get(requestId) ?? attemptId,
        abort_reason: committed ? '' : lastAbortReason,
        start_ts_ms: requestStartMs,
        end_ts_ms: requestEndMs,
        latency_ms: requestEndMs - requestStartMs
      });
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker(i));
  await Promise.all(workers);

  return { startMs, endMs: nowMs(), durationMs: nowMs() - startMs, attemptsPerRequest };
}

module.exports = { runClosedLoop };
