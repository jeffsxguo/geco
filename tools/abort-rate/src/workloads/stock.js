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

function buildStockTradeGenerator({ numAccounts, hotAccountFraction, conflictRatio, seed, scenarioName }) {
  const rng = seedrandom(String(seed ?? 0));
  const pools = buildAccountPools(numAccounts, hotAccountFraction ?? 0.01);

  function pickAccount() {
    const useHot = rng() < (conflictRatio ?? 0);
    const pool = useHot ? pools.hot : pools.cold;
    return randomChoice(rng, pool);
  }

  function nextRequest(context) {
    let from = pickAccount();
    let to = pickAccount();
    if (scenarioName === 'single_hot_sender') {
      from = pools.hot[0];
      to = randomChoice(rng, pools.cold);
    }
    while (to === from) to = pickAccount();

    const amount = '1';
    const windowIndex = context?.windowIndex ?? null;
    return {
      functionName: 'Trade',
      args: [from, to, amount],
      meta: {
        from,
        to,
        amount,
        window_index: windowIndex,
        window_id: windowIndex === null ? '' : `w_${String(windowIndex).padStart(6, '0')}`
      }
    };
  }

  return { nextRequest, pools };
}

module.exports = { buildStockTradeGenerator };

