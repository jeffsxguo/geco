const path = require('node:path');
const { spawnSync } = require('node:child_process');

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { loadJson, setByDottedPath } = require('./config');

function cartesianProduct(entries) {
  const keys = Object.keys(entries);
  const valuesList = keys.map((k) => entries[k]);
  const results = [];

  function helper(i, current) {
    if (i === keys.length) {
      results.push({ ...current });
      return;
    }
    const key = keys[i];
    for (const value of valuesList[i]) {
      current[key] = value;
      helper(i + 1, current);
    }
  }

  helper(0, {});
  return results;
}

function run() {
  const argv = yargs(hideBin(process.argv))
    .option('config', { type: 'string', demandOption: true, describe: 'Path to sweep JSON config' })
    .strict()
    .parseSync();

  const sweepConfig = loadJson(argv.config);
  const baseConfigPath = sweepConfig.baseConfigPath;
  const matrix = sweepConfig.matrix || {};

  const baseConfig = loadJson(baseConfigPath);
  const combos = cartesianProduct(matrix);

  process.stdout.write(`sweep: ${combos.length} runs\n`);

  for (let i = 0; i < combos.length; i++) {
    const combo = combos[i];
    const config = JSON.parse(JSON.stringify(baseConfig));
    for (const [dottedKey, value] of Object.entries(combo)) {
      setByDottedPath(config, dottedKey, value);
    }

    const tmpPath = path.resolve(process.cwd(), `.tmp.run.${i}.json`);
    require('node:fs').writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');

    process.stdout.write(`\n[${i + 1}/${combos.length}] ${JSON.stringify(combo)}\n`);
    const res = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--config', tmpPath], {
      stdio: 'inherit',
      env: process.env
    });

    require('node:fs').unlinkSync(tmpPath);

    if (res.status !== 0) {
      process.stderr.write(`Run failed at combo ${i + 1}\n`);
      process.exit(res.status ?? 1);
    }
  }
}

run();

