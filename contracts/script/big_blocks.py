#!/usr/bin/env python3
"""Toggle HyperEVM big blocks for the deployer key only.

The market implementation does not fit in a 3,000,000-gas small block, so the
deployer turns big blocks on, broadcasts DeployV3, then turns them off.
Listings, settles, the keeper, and the owner Safe stay on small blocks.

Reads DEPLOYER_PRIVATE_KEY from the environment. Refuses that key when it is
also OWNER, GUARDIAN, KEEPER_ADDRESS, or KEEPER_PRIVATE_KEY. The key is not
printed.

    python3 script/big_blocks.py on              # testnet exchange
    python3 script/big_blocks.py off
    python3 script/big_blocks.py on --mainnet
    python3 script/big_blocks.py off --mainnet
    python3 script/big_blocks.py on --dry-run

Requires `cast` on PATH and `msgpack` (`pip install msgpack`). Posts
{"type":"evmUserModify","usingBigBlocks":true|false} to the Hyperliquid
exchange API. Does nothing to an EVM contract.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request

TESTNET = "https://api.hyperliquid-testnet.xyz/exchange"
MAINNET = "https://api.hyperliquid.xyz/exchange"


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def cast(*args: str) -> str:
    proc = subprocess.run(["cast", *args], check=False, capture_output=True, text=True)
    if proc.returncode != 0:
        die(proc.stderr.strip() or "cast failed")
    return proc.stdout.strip()


def action_bytes(using_big_blocks: bool, nonce_ms: int) -> bytes:
    import msgpack

    action = {"type": "evmUserModify", "usingBigBlocks": using_big_blocks}
    packed = msgpack.packb(action)
    return packed + nonce_ms.to_bytes(8, "big") + b"\x00"


def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] not in ("on", "off"):
        die("usage: big_blocks.py on|off [--mainnet] [--dry-run]")
    enable = args[0] == "on"
    mainnet = "--mainnet" in args
    dry = "--dry-run" in args

    pk = os.environ.get("DEPLOYER_PRIVATE_KEY", "").strip()
    if not pk:
        die("DEPLOYER_PRIVATE_KEY is required")
    keeper_pk = os.environ.get("KEEPER_PRIVATE_KEY", "").strip()
    if keeper_pk and keeper_pk.lower() == pk.lower():
        die("refusing: DEPLOYER_PRIVATE_KEY is the keeper key")

    addr = cast("wallet", "address", "--private-key", pk)
    for name in ("OWNER", "GUARDIAN", "KEEPER_ADDRESS"):
        other = os.environ.get(name, "").strip()
        if other and other.lower() == addr.lower():
            die(f"refusing: deployer address is {name}")

    nonce = int(time.time() * 1000)
    raw = action_bytes(enable, nonce)
    connection = cast("keccak", "0x" + raw.hex())
    typed = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Agent": [
                {"name": "source", "type": "string"},
                {"name": "connectionId", "type": "bytes32"},
            ],
        },
        "primaryType": "Agent",
        "domain": {
            "name": "Exchange",
            "version": "1",
            "chainId": 1337,
            "verifyingContract": "0x0000000000000000000000000000000000000000",
        },
        "message": {"source": "a" if mainnet else "b", "connectionId": connection},
    }
    signature = cast("wallet", "sign", "--data", json.dumps(typed), "--private-key", pk)
    if not signature.startswith("0x") or len(signature) != 132:
        die("unexpected signature")
    r = signature[:66]
    s = "0x" + signature[66:130]
    v = int(signature[130:132], 16)
    body = {
        "action": {"type": "evmUserModify", "usingBigBlocks": enable},
        "nonce": nonce,
        "signature": {"r": r, "s": s, "v": v},
    }
    url = MAINNET if mainnet else TESTNET
    print(f"deployer {addr} big blocks {'on' if enable else 'off'} -> {url}")
    if dry:
        print("dry-run: not posted")
        return
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        print(res.read().decode())


if __name__ == "__main__":
    try:
        import msgpack  # noqa: F401
    except ImportError:
        die("pip install msgpack")
    main()
