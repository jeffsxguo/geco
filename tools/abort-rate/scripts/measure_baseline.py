#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Dict, List, Tuple


@dataclass(frozen=True)
class Counters:
    cpu_usage_usec: int
    mem_current_bytes: int
    net_rx_bytes: int
    net_tx_bytes: int


def run(cmd: List[str], *, cwd: str | None = None, check: bool = True, capture: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=cwd,
        check=check,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def docker_inspect_id(container: str) -> str:
    cp = run(["docker", "inspect", "-f", "{{.Id}}", container])
    cid = (cp.stdout or "").strip()
    if not cid:
        raise RuntimeError(f"failed to inspect container id: {container}\n{cp.stderr}")
    return cid


def cgroup_path_for_container(container: str) -> str:
    cid = docker_inspect_id(container)
    path = f"/sys/fs/cgroup/system.slice/docker-{cid}.scope"
    if not os.path.isdir(path):
        raise RuntimeError(f"cgroup path not found for {container}: {path}")
    return path


def read_int(path: str) -> int:
    with open(path, "r", encoding="utf-8") as f:
        return int(f.read().strip())


def read_cpu_usage_usec(cg: str) -> int:
    cpu_stat = os.path.join(cg, "cpu.stat")
    with open(cpu_stat, "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith("usage_usec "):
                return int(line.split()[1])
    raise RuntimeError(f"usage_usec not found in {cpu_stat}")


def read_mem_current_bytes(cg: str) -> int:
    return read_int(os.path.join(cg, "memory.current"))


def read_net_bytes(container: str) -> Tuple[int, int]:
    # Assume default docker interface name is eth0.
    # This counts container network traffic (RX/TX) since container start.
    cp = run(
        [
            "docker",
            "exec",
            container,
            "sh",
            "-lc",
            "cat /sys/class/net/eth0/statistics/rx_bytes; cat /sys/class/net/eth0/statistics/tx_bytes",
        ]
    )
    lines = [ln.strip() for ln in (cp.stdout or "").splitlines() if ln.strip()]
    if len(lines) < 2:
        raise RuntimeError(f"unexpected net bytes output for {container}: {cp.stdout}\n{cp.stderr}")
    return int(lines[0]), int(lines[1])


def read_counters(container: str) -> Counters:
    cg = cgroup_path_for_container(container)
    cpu = read_cpu_usage_usec(cg)
    mem = read_mem_current_bytes(cg)
    rx, tx = read_net_bytes(container)
    return Counters(cpu_usage_usec=cpu, mem_current_bytes=mem, net_rx_bytes=rx, net_tx_bytes=tx)


def avg_and_peak(samples: List[Tuple[float, int]]) -> Tuple[float, int]:
    if len(samples) < 2:
        return 0.0, 0
    total = 0.0
    peak = 0
    for (t0, v0), (t1, v1) in zip(samples, samples[1:]):
        dt = max(0.0, t1 - t0)
        total += 0.5 * (v0 + v1) * dt
        peak = max(peak, v0, v1)
    duration = max(1e-9, samples[-1][0] - samples[0][0])
    return total / duration, peak


def parse_run_output(stdout: str) -> Dict[str, str]:
    out = {}
    for line in (stdout or "").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Measure baseline CPU/memory/network per committed SmallBank Transfer on local Fabric network."
    )
    parser.add_argument(
        "--config",
        required=True,
        help="Path to abort-rate runner config JSON (e.g. configs/local.smallbank.baseline.json)",
    )
    parser.add_argument(
        "--containers",
        nargs="*",
        default=[
            "geco-hlf-orderer.example.com-1",
            "geco-hlf-peer0.org1.example.com-1",
            "geco-hlf-smallbank-ccaas-1",
        ],
        help="Container names to include in server-side resource totals.",
    )
    parser.add_argument("--warmup-seconds", type=float, default=3.0, help="Seconds to wait before sampling.")
    parser.add_argument("--sample-interval", type=float, default=0.2, help="Memory sampling interval during run.")
    parser.add_argument(
        "--abort-rate-dir",
        default=os.path.join(os.path.dirname(__file__), ".."),
        help="Path to tools/abort-rate directory (default: ../ from this script).",
    )
    args = parser.parse_args()

    abort_rate_dir = os.path.abspath(args.abort_rate_dir)
    config_path = args.config
    if not os.path.isabs(config_path):
        config_path = os.path.join(abort_rate_dir, config_path)
    config_path = os.path.abspath(config_path)

    # 1) Warmup delay (no baseline subtraction for memory).
    if args.warmup_seconds > 0:
        time.sleep(args.warmup_seconds)

    # 2) Snapshot counters before run (CPU/NET), and start memory sampling.
    before: Dict[str, Counters] = {c: read_counters(c) for c in args.containers}

    mem_samples: Dict[str, List[Tuple[float, int]]] = {c: [] for c in args.containers}
    total_mem_samples: List[Tuple[float, int]] = []

    run_start = time.time()
    proc = subprocess.Popen(
        ["node", "src/run.js", "--config", config_path],
        cwd=abort_rate_dir,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        while True:
            now = time.time()
            total_mem = 0
            for c in args.containers:
                cg = cgroup_path_for_container(c)
                current = read_mem_current_bytes(cg)
                mem_samples[c].append((now, current))
                total_mem += current
            total_mem_samples.append((now, total_mem))

            if proc.poll() is not None:
                break
            time.sleep(args.sample_interval)
    finally:
        stdout, stderr = proc.communicate()
    run_end = time.time()

    if proc.returncode != 0:
        sys.stderr.write("runner failed\n")
        sys.stderr.write(stdout or "")
        sys.stderr.write(stderr or "")
        return proc.returncode

    out = parse_run_output(stdout)
    summary_path = out.get("summary")
    if not summary_path:
        sys.stderr.write("could not find summary path in runner output\n")
        sys.stderr.write(stdout or "")
        return 2

    with open(summary_path, "r", encoding="utf-8") as f:
        summary = json.load(f)

    committed_txs = int(summary["summary"]["attempts"]["committed"])
    if committed_txs <= 0:
        raise RuntimeError(f"no committed requests; cannot compute per-commit baseline. summary={summary_path}")

    # 3) Snapshot counters after run.
    after: Dict[str, Counters] = {c: read_counters(c) for c in args.containers}

    totals = {
        "cpu_seconds": 0.0,
        "net_rx_bytes": 0,
        "net_tx_bytes": 0,
    }
    per_container = {}

    for c in args.containers:
        b = before[c]
        a = after[c]
        cpu_sec = max(0, a.cpu_usage_usec - b.cpu_usage_usec) / 1e6
        net_rx = max(0, a.net_rx_bytes - b.net_rx_bytes)
        net_tx = max(0, a.net_tx_bytes - b.net_tx_bytes)
        avg_mem, peak_mem = avg_and_peak(mem_samples[c])

        totals["cpu_seconds"] += cpu_sec
        totals["net_rx_bytes"] += net_rx
        totals["net_tx_bytes"] += net_tx
        per_container[c] = {
            "cpu_seconds": cpu_sec,
            "net_rx_bytes": net_rx,
            "net_tx_bytes": net_tx,
            "avg_mem_bytes": avg_mem,
            "peak_mem_bytes": peak_mem,
        }

    avg_total_mem, peak_total_mem = avg_and_peak(total_mem_samples)
    memory = {
        "total": {
            "avg_bytes": avg_total_mem,
            "peak_bytes": peak_total_mem,
            "avg_mib": avg_total_mem / (1024 * 1024),
            "peak_mib": peak_total_mem / (1024 * 1024),
        },
        "per_container": {},
    }
    for c, stats in per_container.items():
        memory["per_container"][c] = {
            "avg_bytes": stats["avg_mem_bytes"],
            "peak_bytes": stats["peak_mem_bytes"],
            "avg_mib": stats["avg_mem_bytes"] / (1024 * 1024),
            "peak_mib": stats["peak_mem_bytes"] / (1024 * 1024),
        }

    result = {
        "runner": {
            "stdout": stdout,
            "summary_path": summary_path,
            "committed_transactions": committed_txs,
        },
        "containers": args.containers,
        "run": {
            "start_ts": run_start,
            "end_ts": run_end,
            "duration_seconds": max(0.0, run_end - run_start),
        },
        "totals": totals,
        "memory": memory,
        "per_container": per_container,
        "per_committed_transaction": {
            "cpu_seconds": totals["cpu_seconds"] / committed_txs,
            "net_rx_bytes": totals["net_rx_bytes"] / committed_txs,
            "net_tx_bytes": totals["net_tx_bytes"] / committed_txs,
        },
    }

    sys.stdout.write(json.dumps(result, indent=2))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
