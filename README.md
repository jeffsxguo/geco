# GECO Submit

This repository contains GECO-related code and experimental tools for submission and reproduction.

## Structure
- `chaincode/`: chaincode implementation (Go).
- `tools/abort-rate/`: experiment scripts and configs (Node.js).
- `tools/hlf-network/`: HLF network configs and scripts.

## Install Dependencies
From the repo root:

```bash
./install_deps.sh
```

## Notes
- `tools/abort-rate/results/` holds experiment outputs and is kept.
- Generated dependency directories (e.g., `node_modules`) are not committed.
