const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { loadJson, validateConfig } = require('./config');
const { connectFabricGateway } = require('./fabric');

async function submitOnce(contract, functionName, args) {
  const proposal = contract.newProposal(functionName, { arguments: args });
  const endorsed = await proposal.endorse();
  const submitted = await endorsed.submit();
  return submitted.getStatus();
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('config', { type: 'string', demandOption: true, describe: 'Path to JSON config' })
    .option('numAccounts', { type: 'number', describe: 'Override workload.numAccounts' })
    .option('initialBalance', { type: 'number', describe: 'Override workload.initialBalance' })
    .strict()
    .parseSync();

  const config = loadJson(argv.config);
  validateConfig(config);

  const numAccounts = argv.numAccounts ?? config.workload.numAccounts;
  const initialBalance = argv.initialBalance ?? config.workload.initialBalance ?? 1000000;

  const timeoutMs = Number(process.env.GECO_INIT_TIMEOUT_MS ?? 60000);
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;

  const gateway = await connectFabricGateway(config.fabric, {
    endorseTimeoutMs: safeTimeoutMs,
    submitTimeoutMs: safeTimeoutMs,
    commitStatusTimeoutMs: safeTimeoutMs
  });

  const reset = String(process.env.GECO_INIT_RESET ?? '').toLowerCase() === '1';
  let initFn = reset ? 'ResetLedger' : 'InitLedger';
  if (config.workload.name === 'bookkeeping_tx') initFn = 'InitBookLedger';
  if (config.workload.name === 'stock_trade') initFn = 'InitShareLedger';
  if (config.workload.name === 'smallbank_transfer_fhe') initFn = reset ? 'ResetLedgerFHE' : 'InitLedgerFHE';
  if (config.workload.name === 'smallbank_transfer_fhe_zeestar') initFn = reset ? 'ResetLedgerFHE' : 'InitLedgerFHE';

  const batchSizeRaw = Number(process.env.GECO_INIT_BATCH_SIZE ?? 0);
  const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw > 0 ? Math.floor(batchSizeRaw) : 0;

  let status;
  if ((initFn === 'InitLedgerFHE' || initFn === 'ResetLedgerFHE') && batchSize > 0) {
    let start = 1;
    while (start <= numAccounts) {
      const count = Math.min(batchSize, numAccounts - start + 1);
      const batchFn = initFn === 'ResetLedgerFHE' ? 'ResetLedgerFHEBatch' : 'InitLedgerFHEBatch';
      const resp = await submitOnce(gateway.contract, batchFn, [
        String(start),
        String(count),
        String(initialBalance)
      ]);
      status = resp;
      start += count;
    }
  } else {
    const resp = await submitOnce(gateway.contract, initFn, [String(numAccounts), String(initialBalance)]);
    status = resp.status;
  }
  await gateway.close();

  const safeJson = JSON.stringify(status, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  process.stdout.write(`${initFn} status: ${safeJson}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e?.message || String(e)}\n`);
  process.exit(1);
});
