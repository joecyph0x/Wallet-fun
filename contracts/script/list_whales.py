#!/usr/bin/env python3
"""List Season 0 whales on HyperEVM testnet with cast.

Forge simulates scripts locally, and that simulator has no HyperCore precompiles,
so coreUserExists is false there and addWallet never broadcasts. cast send does
not simulate those reads: the transaction runs on chain 998, where the precompile
returns the real bool.

    export ETH_PRIVATE_KEY=0x...        # cast reads this. Never commit it.
    cd contracts
    python3 script/list_whales.py --dry-run   # listings() on chain 998, no send
    python3 script/list_whales.py --write

DEPLOYER_PRIVATE_KEY is accepted too and is copied into ETH_PRIVATE_KEY for the
cast process. The key is never placed on the cast command line.

Refuses every chain id except 998. Sends one addWallet at a time and waits for
the receipt, so nonces stay in order. Listings are about 470k gas and fit in a
small block. The registry create does not: do that with big blocks first.

A whale in script/whales.json is listed even when deployments/998.json has no
row yet, which is how a testnet-only demo whale survives a redeploy. A
per-whale weightedPerps entry overrides the file default. testnetOnly is copied
onto the row and does not change the transaction.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WHALES = ROOT / "script" / "whales.json"
DEPLOY = ROOT / "deployments" / "998.json"
ZERO = "0x0000000000000000000000000000000000000000"
RPC_DEFAULT = "https://rpc.hyperliquid-testnet.xyz/evm"


def _redact(text: str) -> str:
    for name in ("DEPLOYER_PRIVATE_KEY", "ETH_PRIVATE_KEY"):
        key = os.environ.get(name, "")
        if key:
            text = text.replace(key, "[redacted]")
    return text


def _cast(args: list[str], env: dict[str, str] | None = None) -> str:
    proc = subprocess.run(args, check=False, text=True, capture_output=True, env=env)
    if proc.returncode != 0:
        sys.stderr.write(_redact(proc.stderr or proc.stdout))
        raise SystemExit(proc.returncode)
    return proc.stdout.strip()


def _chain_id(rpc: str) -> str:
    return _cast(["cast", "chain-id", "--rpc-url", rpc])


def _listed(rpc: str, registry: str, whale: str) -> str:
    out = _cast(
        [
            "cast",
            "call",
            registry,
            "listings(address)(address,address,bool)",
            whale,
            "--rpc-url",
            rpc,
        ]
    )
    market = out.splitlines()[0].split()[0]
    return market


def _broadcast_key() -> str:
    key = os.environ.get("ETH_PRIVATE_KEY") or os.environ.get("DEPLOYER_PRIVATE_KEY") or ""
    if not key:
        sys.exit("ETH_PRIVATE_KEY is required to broadcast")
    return key


def _add_wallet(rpc: str, registry: str, key: str, whale: str, ticker: str, name: str, perp: int) -> None:
    env = os.environ.copy()
    env["ETH_PRIVATE_KEY"] = key
    # cast reads ETH_PRIVATE_KEY. Do not pass --private-key: it shows up in the process list.
    _cast(
        [
            "cast",
            "send",
            registry,
            "addWallet(address,address[],string,string,uint32[],uint32[])",
            whale,
            "[]",
            ticker,
            name,
            "[0]",
            f"[{perp}]",
            "--rpc-url",
            rpc,
        ],
        env,
    )


def _perp_for(seed: dict, whale: dict) -> int:
    own = whale.get("weightedPerps") or seed["weightedPerps"]
    return int(own[0])


def _ensure_row(book: dict, by_ticker: dict, whale: dict, perp: int) -> dict:
    ticker = whale["ticker"]
    row = by_ticker.get(ticker)
    if row is None:
        row = {
            "ticker": ticker,
            "name": whale["name"],
            "whale": whale["whale"],
            "market": ZERO,
            "weightedPerps": [perp],
            "listError": "",
        }
        book["wallets"].append(row)
        by_ticker[ticker] = row
    if whale.get("testnetOnly"):
        row["testnetOnly"] = True
    row.setdefault("name", whale["name"])
    row.setdefault("weightedPerps", [perp])
    return row


def main() -> None:
    parser = argparse.ArgumentParser(description="List Season 0 whales on HyperEVM testnet")
    parser.add_argument("--rpc-url", default=os.environ.get("RPC_URL", RPC_DEFAULT))
    parser.add_argument("--registry", default=os.environ.get("REGISTRY", ""))
    parser.add_argument("--write", action="store_true", help="record market addresses in deployments/998.json")
    parser.add_argument("--dry-run", action="store_true", help="print actions, send nothing")
    args = parser.parse_args()

    seed = json.loads(WHALES.read_text())
    book = json.loads(DEPLOY.read_text())
    registry = args.registry or book.get("registry") or ""
    if not registry or registry.lower() == ZERO:
        sys.exit("set REGISTRY or put the registry in deployments/998.json")
    default_perp = int(seed["weightedPerps"][0])
    by_ticker = {row["ticker"]: row for row in book["wallets"]}

    chain = _chain_id(args.rpc_url)
    if chain != "998":
        sys.exit(f"refusing chain id {chain}; listing is HyperEVM testnet only")
    key = ""
    if args.dry_run:
        print(f"dry-run chain {chain} registry {registry} default weighted perp {default_perp}")
    else:
        key = _broadcast_key()

    for whale in seed["whales"]:
        ticker = whale["ticker"]
        perp = _perp_for(seed, whale)
        row = by_ticker.get(ticker)
        fresh = row is None
        row = _ensure_row(book, by_ticker, whale, perp)
        flag = " testnet-only" if whale.get("testnetOnly") else ""
        # Ask the registry. A market address left in the file from an older deploy is not a listing.
        market = _listed(args.rpc_url, registry, whale["whale"])
        if args.dry_run:
            if market.lower() == ZERO:
                created = " and add a deployment row" if fresh else ""
                print(f"would addWallet {ticker}{flag} {whale['whale']} dex [0] weight [{perp}]{created}")
            else:
                print(f"skip {ticker}{flag} on-chain market {market}")
            continue
        if market.lower() == ZERO:
            print(f"addWallet {ticker}{flag} weight [{perp}]")
            _add_wallet(args.rpc_url, registry, key, whale["whale"], ticker, whale["name"], perp)
            market = _listed(args.rpc_url, registry, whale["whale"])
            if market.lower() == ZERO:
                sys.exit(f"{ticker} addWallet did not record a market")
        else:
            print(f"skip {ticker}{flag} on-chain market {market}")
        row["market"] = market
        row["whale"] = whale["whale"]
        row["weightedPerps"] = [perp]
        row["listError"] = ""

    if args.write and not args.dry_run:
        book["registry"] = registry
        book["note"] = (
            "Registry from DeploySeason0. Markets from list_whales.py (cast send on chain 998). "
            "Forge simulation has no HyperCore precompiles, so listing is not part of the forge script."
        )
        DEPLOY.write_text(json.dumps(book, indent=2) + "\n")
        print(f"wrote {DEPLOY}")
    elif args.dry_run:
        print("dry-run wrote nothing")


if __name__ == "__main__":
    main()
