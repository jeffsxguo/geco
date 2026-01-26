const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function createJsonlWriter(outputDir, runId) {
  ensureDir(outputDir);
  const jsonlPath = path.join(outputDir, `${runId}.jsonl`);
  const stream = fs.createWriteStream(jsonlPath, { flags: 'a' });

  function write(record) {
    stream.write(`${JSON.stringify(record)}\n`);
  }

  function close() {
    return new Promise((resolve, reject) => {
      stream.end((err) => (err ? reject(err) : resolve()));
    });
  }

  return { jsonlPath, write, close };
}

module.exports = { createJsonlWriter, ensureDir };

