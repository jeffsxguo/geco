const crypto = require('node:crypto');

function stableJsonStringify(obj) {
  return JSON.stringify(obj);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function parseAmount(amountStr) {
  const n = Number(amountStr);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid amount: ${amountStr}`);
  }
  return n;
}

function makeTransferSpec({ from, to, amount, meta, functionName = 'Transfer' }) {
  const payload = stableJsonStringify({ from, to, amount });
  return {
    functionName,
    args: [from, to, String(amount)],
    meta: {
      ...(meta ?? {}),
      payload_sha256: sha256Hex(payload)
    }
  };
}

function buildWindowsByCount({ totalRequests, windowSize }) {
  const windows = [];
  for (let i = 0; i < totalRequests; i++) {
    const w = Math.floor(i / windowSize);
    if (!windows[w]) windows[w] = [];
    windows[w].push(i);
  }
  return windows;
}

function mergeValueTransfers(transfers) {
  const byPair = new Map(); // `${from}\u0000${to}` -> {from,to,amount,origIds:Set}
  for (const t of transfers) {
    if (!byPair.has(t.key)) byPair.set(t.key, { from: t.from, to: t.to, amount: 0, origIds: new Set() });
    const e = byPair.get(t.key);
    e.amount += t.amount;
    if (t.requestId) e.origIds.add(t.requestId);
    if (Array.isArray(t.originalTxIds)) for (const id of t.originalTxIds) e.origIds.add(id);
  }

  const out = [];
  const keys = Array.from(byPair.keys()).sort();
  for (const key of keys) {
    const e = byPair.get(key);
    const amount = e?.amount ?? 0;
    if (amount <= 0) continue;
    const [from, to] = key.split('\u0000');
    if (!from || !to || from === to) continue;
    out.push({
      from,
      to,
      amount,
      key: `${from}\u0000${to}`,
      originalTxIds: Array.from(e.origIds).sort()
    });
  }
  return out;
}

function normalizeSubrequestsToTransfers(subrequests) {
  return subrequests.map((r) => {
    const from = r.requestSpec?.meta?.from;
    const to = r.requestSpec?.meta?.to;
    const amount = parseAmount(r.requestSpec?.meta?.amount);
    if (!from || !to) throw new Error(`invalid subrequest (missing from/to): ${r.requestId}`);
    return { from, to, amount, key: `${from}\u0000${to}`, requestId: r.requestId };
  });
}

function parseInt64String(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`invalid int64: ${s}`);
  return n;
}

function normalizeSubrequestsToBookkeeping(subrequests) {
  return subrequests.map((r) => {
    const id = r.requestSpec?.meta?.id;
    const deltaStr = r.requestSpec?.meta?.delta;
    if (!id) throw new Error(`invalid bookkeeping subrequest (missing id): ${r.requestId}`);
    if (deltaStr === undefined || deltaStr === null) throw new Error(`invalid bookkeeping subrequest (missing delta): ${r.requestId}`);
    const delta = parseInt64String(deltaStr);
    return { id, delta, key: id, requestId: r.requestId };
  });
}

function mergeBookkeepingValue(ops) {
  const byId = new Map(); // id -> {delta, origIds:Set}
  for (const o of ops) {
    if (!byId.has(o.id)) byId.set(o.id, { delta: 0, origIds: new Set() });
    const e = byId.get(o.id);
    e.delta += o.delta;
    if (o.requestId) e.origIds.add(o.requestId);
  }

  const out = [];
  const ids = Array.from(byId.keys()).sort();
  for (const id of ids) {
    const e = byId.get(id);
    const delta = e?.delta ?? 0;
    if (delta === 0) continue;
    out.push({ id, delta, originalTxIds: Array.from(e.origIds).sort() });
  }
  return out;
}

function mergeKeyTransfersEqualAmount(transfers) {
  // Key-merge (chain compression) restricted to equal amount:
  // if u->v (x) and v->w (x) exist, they can be merged into u->w (x).
  // Implemented as repeated cancellation per amount level with deterministic pairing,
  // iterating to a fixpoint (because new cancellable chains can appear after a round).
  const byAmount = new Map(); // amount -> array of {from,to,amount,key}
  for (const t of transfers) {
    if (!byAmount.has(t.amount)) byAmount.set(t.amount, []);
    byAmount.get(t.amount).push({ ...t });
  }

  const amounts = Array.from(byAmount.keys()).sort((a, b) => a - b);
  const out = [];

  for (const amount of amounts) {
    const edges = byAmount.get(amount) ?? [];

    // Edge multiset: "from\0to" -> array of edge provenance objects.
    const edgeBucket = new Map();
    const nodesSet = new Set();

    for (const e of edges) {
      if (!e.from || !e.to || e.from === e.to) continue;
      nodesSet.add(e.from);
      nodesSet.add(e.to);
      const k = `${e.from}\u0000${e.to}`;
      if (!edgeBucket.has(k)) edgeBucket.set(k, []);
      const ids = new Set();
      if (Array.isArray(e.originalTxIds)) for (const id of e.originalTxIds) ids.add(id);
      if (e.requestId) ids.add(e.requestId);
      edgeBucket.get(k).push({ originalTxIds: Array.from(ids).sort() });
    }

    const nodes = Array.from(nodesSet).sort();

    function buildAdj() {
      const incoming = new Map(); // node -> Map(from -> count)
      const outgoing = new Map(); // node -> Map(to -> count)

      function inc(map, a, b, delta) {
        if (!map.has(a)) map.set(a, new Map());
        const inner = map.get(a);
        inner.set(b, (inner.get(b) ?? 0) + delta);
        if (inner.get(b) === 0) inner.delete(b);
        if (inner.size === 0) map.delete(a);
      }

      for (const [k, bucket] of edgeBucket.entries()) {
        const count = bucket.length;
        if (count <= 0) continue;
        const [from, to] = k.split('\u0000');
        inc(outgoing, from, to, count);
        inc(incoming, to, from, count);
      }

      return { incoming, outgoing };
    }

    function pickSmallestKey(map) {
      const keys = Array.from(map.keys()).sort();
      return keys[0] ?? null;
    }

    function takeEdge(from, to) {
      const k = `${from}\u0000${to}`;
      const bucket = edgeBucket.get(k);
      if (!bucket || bucket.length === 0) return null;
      const e = bucket.pop();
      if (bucket.length === 0) edgeBucket.delete(k);
      return e;
    }

    function addEdge(from, to, edge) {
      if (from === to) return;
      const k = `${from}\u0000${to}`;
      if (!edgeBucket.has(k)) edgeBucket.set(k, []);
      edgeBucket.get(k).push(edge);
      nodesSet.add(from);
      nodesSet.add(to);
    }

    // Fixpoint iteration: cancellation may introduce new cancellable chains.
    while (true) {
      let changed = false;
      const { incoming, outgoing } = buildAdj();

      const mids = Array.from(new Set([...incoming.keys(), ...outgoing.keys()])).sort();
      for (const mid of mids) {
        while (true) {
          const ins = incoming.get(mid);
          const outs = outgoing.get(mid);
          if (!ins || !outs) break;
          const u = pickSmallestKey(ins);
          const w = pickSmallestKey(outs);
          if (!u || !w) break;

          // Consume one u->mid and one mid->w, produce u->w.
          const e1 = takeEdge(u, mid);
          const e2 = takeEdge(mid, w);
          if (!e1 || !e2) break;
          const ids = new Set();
          for (const id of e1.originalTxIds ?? []) ids.add(id);
          for (const id of e2.originalTxIds ?? []) ids.add(id);
          addEdge(u, w, { originalTxIds: Array.from(ids).sort() });
          changed = true;
        }
      }

      if (!changed) break;
    }

    // Emit remaining edges of this amount level.
    const edgeKeys = Array.from(edgeBucket.keys()).sort();
    for (const k of edgeKeys) {
      const [from, to] = k.split('\u0000');
      const bucket = edgeBucket.get(k) ?? [];
      for (const e of bucket) {
        out.push({ from, to, amount, key: `${from}\u0000${to}`, originalTxIds: e.originalTxIds ?? [] });
      }
    }
  }

  return mergeValueTransfers(out);
}

function mergeValueThenKeyTransfers(transfers) {
  // Exactly: value merge first (aggregate same from/to), then key merge with strict equal amount.
  const afterValue = mergeValueTransfers(transfers);
  // Do NOT apply value merge again after key merge; keep semantics "value then key".
  return mergeKeyTransfersEqualAmount(afterValue);
}

function mergeKeyThenValueTransfers(transfers) {
  // Strict equal-amount key merge first, then value merge. This is effectively the existing
  // `key_merge` behavior, but provided as an explicit mode for experiments.
  return mergeKeyTransfersEqualAmount(transfers);
}

function keysOfSubrequest(sr) {
  const from = sr.requestSpec?.meta?.from;
  const to = sr.requestSpec?.meta?.to;
  return [from, to].filter(Boolean);
}

function buildKeyGroups(subrequests) {
  // Union-find grouping by key overlap: if two subrequests touch any common key, they belong to same group.
  const n = subrequests.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  const keyToIndex = new Map();
  for (let i = 0; i < n; i++) {
    const keys = keysOfSubrequest(subrequests[i]);
    for (const k of keys) {
      const prev = keyToIndex.get(k);
      if (prev !== undefined) union(i, prev);
      else keyToIndex.set(k, i);
    }
  }

  const groupsByRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groupsByRoot.has(r)) groupsByRoot.set(r, []);
    groupsByRoot.get(r).push(subrequests[i]);
  }

  // Deterministic order: sort groups by smallest original request_id within group.
  const groups = Array.from(groupsByRoot.values());
  groups.sort((a, b) => {
    const aMin = a.map((x) => x.requestId).sort()[0] ?? '';
    const bMin = b.map((x) => x.requestId).sort()[0] ?? '';
    return aMin.localeCompare(bMin);
  });

  return groups;
}

function prepareWindowedMergePlan({ totalRequests, makeRequest, windowSpec, mergeType, requestIdPrefix = 'req' }) {
  if (!windowSpec || windowSpec.type !== 'count') {
    throw new Error('window merge currently supports only driver.window.type="count"');
  }
  const windowSize = Number(windowSpec.size);
  if (!Number.isFinite(windowSize) || windowSize <= 0) {
    throw new Error('driver.window.size must be a positive number');
  }

  const windowRequestIdPrefix = `${requestIdPrefix}_win`;

  const windows = buildWindowsByCount({ totalRequests, windowSize });
  const originalRequests = new Array(totalRequests);

  for (let i = 0; i < totalRequests; i++) {
    const requestId = `${requestIdPrefix}_${String(i).padStart(8, '0')}`;
    const windowIndex = Math.floor(i / windowSize);
    const requestSpec = makeRequest({
      requestIndex: i,
      requestId,
      workerId: -1,
      requestStartMs: 0,
      windowIndex
    });

    originalRequests[i] = { requestId, windowIndex, requestSpec };
  }

  let windowRequests = [];
  if (mergeType === 'ctm') {
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
      const requestIndices = windows[windowIndex] ?? [];
      const subrequests = requestIndices.map((idx) => originalRequests[idx]);
      const groups = buildKeyGroups(subrequests);

      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const groupSubrequests = groups[groupIndex];
        const transfers = normalizeSubrequestsToTransfers(groupSubrequests);
        const mergeStartMs = Date.now();
        const mergedTransfers = mergeKeyThenValueTransfers(transfers);
        const mergeMs = Date.now() - mergeStartMs;
        const mergeMsPerTx = mergedTransfers.length > 0 ? mergeMs / mergedTransfers.length : mergeMs;
        const totalOriginalAmount = transfers.reduce((acc, t) => acc + t.amount, 0);
        const fn = groupSubrequests[0]?.requestSpec?.functionName ?? 'Transfer';

        for (let txIndex = 0; txIndex < mergedTransfers.length; txIndex++) {
          const t = mergedTransfers[txIndex];
          const windowRequestId = `${windowRequestIdPrefix}_${String(windowIndex).padStart(6, '0')}_g_${String(
            groupIndex
          ).padStart(4, '0')}_t_${String(txIndex).padStart(4, '0')}`;

          const originalEquivCount = totalOriginalAmount > 0 ? (groupSubrequests.length * t.amount) / totalOriginalAmount : 0;
          const originalTxIds = Array.isArray(t.originalTxIds) ? t.originalTxIds : [];

          const mergedSpec = makeTransferSpec({
            from: t.from,
            to: t.to,
            amount: t.amount,
            functionName: fn,
            meta: {
              merge_type: 'ctm',
              window_index: windowIndex,
              group_index: groupIndex,
              group_count_in_window: groups.length,
              tx_index: txIndex,
              merged_transfer_count: mergedTransfers.length,
              subrequest_count: groupSubrequests.length,
              subrequest_ids: groupSubrequests.map((r) => r.requestId),
              // Practical accounting for abort-rate normalization at the "original tx count" level:
              // for variable amounts, use a fractional mapping proportional to merged amount.
              original_equiv_count: originalEquivCount,
              original_tx_count_unique: originalTxIds.length,
              original_tx_ids: originalTxIds,
              p_merge_ms: mergeMsPerTx
            }
          });

          windowRequests.push({
            windowIndex,
            groupIndex,
            groupCountInWindow: groups.length,
            windowRequestId,
            mergedSpec,
            subrequests: groupSubrequests
          });
        }
      }
    }
  } else {
    windowRequests = windows.flatMap((requestIndices, windowIndex) => {
      const subrequests = requestIndices.map((idx) => originalRequests[idx]);
      const fn = subrequests[0]?.requestSpec?.functionName ?? '';

      let mergedTransfers = [];
      if (fn === 'Transfer' || fn === 'Trade') {
        const transfers = normalizeSubrequestsToTransfers(subrequests);
        const totalOriginalAmount = transfers.reduce((acc, t) => acc + t.amount, 0);

        if (mergeType === 'value_merge') {
          mergedTransfers = mergeValueTransfers(transfers);
        } else if (mergeType === 'value_then_key') {
          mergedTransfers = mergeValueThenKeyTransfers(transfers);
        } else if (mergeType === 'key_then_value') {
          mergedTransfers = mergeKeyThenValueTransfers(transfers);
        } else if (mergeType === 'key_merge') {
          mergedTransfers = mergeKeyTransfersEqualAmount(transfers);
        } else {
          throw new Error(`Unsupported mergeType: ${mergeType}`);
        }

        return mergedTransfers.map((t, txIndex) => {
          const windowRequestId = `${windowRequestIdPrefix}_${String(windowIndex).padStart(6, '0')}_t_${String(
            txIndex
          ).padStart(4, '0')}`;
          const originalEquivCount = totalOriginalAmount > 0 ? (subrequests.length * t.amount) / totalOriginalAmount : 0;
          const mergedSpec = {
            functionName: fn,
            args: [t.from, t.to, String(t.amount)],
            meta: {
              merge_type: mergeType,
              window_index: windowIndex,
              tx_index: txIndex,
              merged_transfer_count: mergedTransfers.length,
              subrequest_count: subrequests.length,
              subrequest_ids: subrequests.map((r) => r.requestId),
              original_equiv_count: originalEquivCount,
              payload_sha256: sha256Hex(stableJsonStringify({ from: t.from, to: t.to, amount: t.amount }))
            }
          };
          if (Array.isArray(t.originalTxIds) && t.originalTxIds.length > 0) {
            mergedSpec.meta.original_tx_ids = t.originalTxIds;
            mergedSpec.meta.original_tx_count_unique = t.originalTxIds.length;
          }
          return { windowIndex, windowRequestId, mergedSpec, subrequests };
        });
      } else {
        if (fn === 'AccountTxn') {
          if (mergeType !== 'value_merge') {
            throw new Error(`mergeType ${mergeType} is not supported for AccountTxn (only value_merge)`);
          }

          const ops = normalizeSubrequestsToBookkeeping(subrequests);
          const mergedOps = mergeBookkeepingValue(ops);

          return mergedOps.map((o, txIndex) => {
            const windowRequestId = `${windowRequestIdPrefix}_${String(windowIndex).padStart(6, '0')}_t_${String(
              txIndex
            ).padStart(4, '0')}`;
            const mergedSpec = {
              functionName: 'AccountTxn',
              args: [o.id, String(o.delta)],
              meta: {
                merge_type: 'value_merge',
                window_index: windowIndex,
                tx_index: txIndex,
                merged_transfer_count: mergedOps.length,
                subrequest_count: subrequests.length,
                subrequest_ids: subrequests.map((r) => r.requestId),
                original_tx_ids: o.originalTxIds,
                original_tx_count_unique: o.originalTxIds.length,
                payload_sha256: sha256Hex(stableJsonStringify({ id: o.id, delta: o.delta }))
              }
            };
            return { windowIndex, windowRequestId, mergedSpec, subrequests };
          });
        }
        throw new Error(`Unsupported function for window merge: ${fn}`);
      }
    });
  }

  return {
    originalRequests,
    windowRequests,
    windowSize,
    mergeType
  };
}

module.exports = {
  prepareWindowedMergePlan,
  mergeValueTransfers,
  mergeKeyTransfersEqualAmount,
  mergeValueThenKeyTransfers,
  mergeKeyThenValueTransfers,
  mergeBookkeepingValue
};
