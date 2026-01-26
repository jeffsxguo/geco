#!/usr/bin/env node
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { mergeKeyThenValueTransfers } = require('./window-merge');

function parseTransfersJson(json) {
  const arr = JSON.parse(json);
  if (!Array.isArray(arr)) throw new Error('transfers JSON must be an array');
  return arr.map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`transfer[${i}] must be an object`);
    const from = String(t.from ?? '');
    const to = String(t.to ?? '');
    const amount = Number(t.amount);
    if (!from || !to) throw new Error(`transfer[${i}] missing from/to`);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) throw new Error(`transfer[${i}] invalid amount`);
    return { from, to, amount };
  });
}

function toInputTransfers(specs) {
  return specs.map((t, i) => ({
    from: t.from,
    to: t.to,
    amount: t.amount,
    key: `${t.from}\u0000${t.to}`,
    requestId: `T${i + 1}`
  }));
}

function printTransfer(label, t) {
  const prov = Array.isArray(t.originalTxIds) ? ` prov=${JSON.stringify(t.originalTxIds)}` : '';
  process.stdout.write(`${label} ${t.from} -${t.amount}-> ${t.to}${prov}\n`);
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('example', {
      type: 'string',
      default: 'split',
      choices: ['split', 'chain', 'mix'],
      describe: 'Built-in example to run'
    })
    .option('transfers', {
      type: 'string',
      describe: 'Custom transfers JSON, e.g. \'[{"from":"A","to":"B","amount":10},{"from":"B","to":"C","amount":6}]\''
    })
    .strict()
    .parseSync();

  let specs = [];
  if (argv.transfers) {
    specs = parseTransfersJson(argv.transfers);
  } else if (argv.example === 'split') {
    specs = [
      { from: 'A', to: 'B', amount: 10 },
      { from: 'B', to: 'C', amount: 6 },
      { from: 'B', to: 'D', amount: 4 }
    ];
  } else if (argv.example === 'chain') {
    specs = [
      { from: 'A', to: 'B', amount: 5 },
      { from: 'B', to: 'C', amount: 5 },
      { from: 'C', to: 'D', amount: 5 }
    ];
  } else if (argv.example === 'mix') {
    specs = [
      { from: 'A', to: 'B', amount: 10 },
      { from: 'A', to: 'B', amount: 5 },
      { from: 'B', to: 'C', amount: 6 },
      { from: 'B', to: 'D', amount: 9 }
    ];
  }

  const inputs = toInputTransfers(specs);
  process.stdout.write('Original transfers:\n');
  for (let i = 0; i < inputs.length; i++) {
    printTransfer(`T${i + 1}:`, inputs[i]);
  }

  const merged = mergeKeyThenValueTransfers(inputs);
  process.stdout.write('\nCTM (key-then-value) merged transfers (with provenance):\n');
  for (let i = 0; i < merged.length; i++) {
    printTransfer(`M${i + 1}:`, merged[i]);
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e?.message || String(e)}\n`);
  process.exit(1);
});
