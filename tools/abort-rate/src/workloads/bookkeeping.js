const seedrandom = require('seedrandom');

function padAccountId(index) {
  const width = 8;
  const number = String(index).padStart(width, '0');
  return `acct${number}`;
}

function buildAccountPools(numAccounts, hotAccountFraction) {
  const hotCount = Math.max(1, Math.floor(numAccounts * hotAccountFraction));
  const hot = [];
  const cold = [];

  for (let i = 1; i <= numAccounts; i++) {
    const id = padAccountId(i);
    if (i <= hotCount) hot.push(id);
    else cold.push(id);
  }

  return { hot, cold };
}

function randomChoice(rng, array) {
  return array[Math.floor(rng() * array.length)];
}

function pickMagnitude(rng, amountSpec) {
  if (!amountSpec || amountSpec.type === 'fixed') return Number(amountSpec?.value ?? 1);
  if (amountSpec.type === 'uniform_int') {
    const min = amountSpec.min ?? 1;
    const max = amountSpec.max ?? 100;
    const v = min + Math.floor(rng() * (max - min + 1));
    return v;
  }
  return 1;
}

function buildBookkeepingGenerator({ numAccounts, hotAccountFraction, conflictRatio, seed, deltaSpec, scenarioName }) {
  const rng = seedrandom(String(seed ?? 0));
  const pools = buildAccountPools(numAccounts, hotAccountFraction ?? 0.01);

  function pickAccountId() {
    const useHot = rng() < (conflictRatio ?? 0);
    const pool = useHot ? pools.hot : pools.cold;
    return randomChoice(rng, pool);
  }

  function nextRequest(context) {
    const id = pickAccountId();
    const magnitude = pickMagnitude(rng, deltaSpec);
    const sign = rng() < 0.5 ? -1 : 1;
    const delta = sign * magnitude;

    const windowIndex = context?.windowIndex ?? null;
    return {
      functionName: 'AccountTxn',
      args: [id, String(delta)],
      meta: {
        id,
        delta: String(delta),
        window_index: windowIndex,
        window_id: windowIndex === null ? '' : `w_${String(windowIndex).padStart(6, '0')}`,
        scenario: scenarioName ?? ''
      }
    };
  }

  return { nextRequest, pools };
}

module.exports = { buildBookkeepingGenerator };

