#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List


WORKLOADS = {
    "baseline": "configs/local.smallbank.baseline.cr0.5.n2000.json",
    "fhe": "configs/local.smallbank.fhe.insecure.cr0.5.n2000.json",
    "zeestar": "configs/local.smallbank.fhe.zeestar.insecure.cr0.5.n2000.json",
    "ctm_fhe": "configs/local.smallbank.ctm.fhe.insecure.window50.cr0.5.n2000.json",
}


def run(cmd: List[str], *, cwd: Path, env: Dict[str, str] | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            cmd,
            cwd=str(cwd),
            env=env,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(f"command failed: {' '.join(cmd)}\n")
        if exc.stdout:
            sys.stderr.write(exc.stdout)
        if exc.stderr:
            sys.stderr.write(exc.stderr)
        raise


def load_json(path: Path) -> Dict:
    return json.loads(path.read_text())


def write_json(path: Path, payload: Dict) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n")


def read_ccaas_pubkey_b64(repo_root: Path) -> str:
    env_path = repo_root / "tools" / "hlf-network" / "ccaas.env"
    if not env_path.exists():
        raise RuntimeError(f"missing {env_path}")
    for line in env_path.read_text().splitlines():
        if line.startswith("GECO_FHE_PUBKEY_B64="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError(f"GECO_FHE_PUBKEY_B64 not found in {env_path}")


def encrypt_amount(repo_root: Path, amount: int, pubkey_b64: str) -> str:
    pubkey_path = repo_root / "tools" / "hlf-network" / ".tmp_pubkey.b64"
    pubkey_path.write_text(pubkey_b64 + "\n")
    cmd = [
        "go",
        "run",
        "./cmd/fhe_tools",
        "-mode",
        "encrypt",
        "-amount",
        str(amount),
        "-pubkey-file",
        str(pubkey_path),
    ]
    cp = run(cmd, cwd=repo_root / "chaincode" / "smallbank-go")
    out = (cp.stdout or "").strip()
    if not out:
        raise RuntimeError(f"empty ciphertext output: {cp.stderr}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Run baseline/FHE/ZeeStar/CTM+FHE matrix across conflict ratios.")
    parser.add_argument("--repo-root", default="..", help="Repo root (default: ../ from scripts/)")
    parser.add_argument("--conflicts", default="0.1,0.5,0.9", help="Comma-separated conflict ratios.")
    parser.add_argument("--amount", type=int, default=1, help="Transfer amount.")
    parser.add_argument("--output-dir", default="results", help="Output dir under tools/abort-rate.")
    parser.add_argument("--warmup-seconds", type=float, default=6.0, help="Warmup seconds for memory baseline.")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    abort_rate_dir = repo_root / "tools" / "abort-rate"
    output_dir = abort_rate_dir / args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    conflicts = [float(x) for x in args.conflicts.split(",") if x.strip()]
    if not conflicts:
        raise RuntimeError("no conflict ratios provided")

    pubkey_b64 = read_ccaas_pubkey_b64(repo_root)
    amount_cipher_b64 = encrypt_amount(repo_root, args.amount, pubkey_b64)

    results = []
    ts = time.strftime("%Y%m%d-%H%M%S")

    for workload, base_config in WORKLOADS.items():
        base_path = abort_rate_dir / base_config
        base = load_json(base_path)

        for cr in conflicts:
            config = json.loads(json.dumps(base))
            config["scenario"]["conflictRatio"] = cr
            config["workload"]["amount"] = config["workload"].get("amount", {})
            if workload == "zeestar":
                config["workload"]["amount"]["type"] = "fhe_ciphertext"
                config["workload"]["amount"]["ciphertextB64"] = amount_cipher_b64
            config["system"] = f"{base['system']}-cr{cr}"
            config["runId"] = ""

            tmp_path = output_dir / f"tmp.{workload}.cr{cr}.{ts}.json"
            write_json(tmp_path, config)

            env = os.environ.copy()
            env["GECO_INIT_RESET"] = "1"
            env["GECO_INIT_BATCH_SIZE"] = "10"

            init_cmd = ["node", "src/init-ledger.js", "--config", str(tmp_path)]
            run(init_cmd, cwd=abort_rate_dir, env=env)

            measure_cmd = [
                "python",
                "scripts/measure_baseline.py",
                "--config",
                str(tmp_path),
                "--warmup-seconds",
                str(args.warmup_seconds),
            ]
            cp = run(measure_cmd, cwd=abort_rate_dir, env=env)
            measurement = json.loads(cp.stdout)

            per = measurement["per_committed_transaction"]
            mem_total = measurement["memory"]["total"]
            results.append(
                {
                    "workload": workload,
                    "conflict_ratio": cr,
                    "committed": measurement["runner"]["committed_transactions"],
                    "cpu_seconds": per["cpu_seconds"],
                    "net_rx_bytes": per["net_rx_bytes"],
                    "net_tx_bytes": per["net_tx_bytes"],
                    "net_total_bytes": per["net_rx_bytes"] + per["net_tx_bytes"],
                    "mem_avg_mib": mem_total["avg_mib"],
                    "mem_peak_mib": mem_total["peak_mib"],
                    "run_id": parse_run_id(measurement["runner"]["stdout"]),
                    "summary_path": measurement["runner"]["summary_path"],
                }
            )

    output_json = output_dir / f"matrix.{ts}.json"
    output_csv = output_dir / f"matrix.{ts}.csv"

    output_json.write_text(json.dumps(results, indent=2) + "\n")

    with output_csv.open("w", encoding="utf-8") as f:
        f.write(
            "workload,conflict_ratio,committed,cpu_seconds,net_rx_bytes,net_tx_bytes,net_total_bytes,mem_avg_mib,mem_peak_mib,run_id,summary_path\n"
        )
        for row in results:
            f.write(
                f"{row['workload']},{row['conflict_ratio']},{row['committed']},"
                f"{row['cpu_seconds']},{row['net_rx_bytes']},{row['net_tx_bytes']},"
                f"{row['net_total_bytes']},{row['mem_avg_mib']},{row['mem_peak_mib']},"
                f"{row['run_id']},{row['summary_path']}\n"
            )

    print(str(output_json))
    print(str(output_csv))
    return 0


def parse_run_id(stdout: str) -> str:
    for line in (stdout or "").splitlines():
        if line.startswith("run_id="):
            return line.split("=", 1)[1].strip()
    return ""


if __name__ == "__main__":
    raise SystemExit(main())
