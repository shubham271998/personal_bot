#!/usr/bin/env python3
"""
Polymarket Trade Executor — Places real orders via py-clob-client

Usage:
  python3 trade-executor.py buy <token_id> <price> <size> <private_key>
  python3 trade-executor.py sell <token_id> <price> <size> <private_key>
  python3 trade-executor.py market_buy <token_id> <amount_usd> <private_key>
  python3 trade-executor.py cancel <order_id> <private_key>
  python3 trade-executor.py cancel_all <private_key>
  python3 trade-executor.py balance <private_key>
  python3 trade-executor.py positions <private_key>
  python3 trade-executor.py approve <private_key>

Output: JSON to stdout
"""
import sys
import json
import os

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command provided"}))
        sys.exit(1)

    cmd = sys.argv[1]

    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import OrderArgs, MarketOrderArgs, OrderType, OpenOrderParams
        from py_clob_client.order_builder.constants import BUY, SELL
    except ImportError:
        print(json.dumps({"error": "py-clob-client not installed. Run: pip3 install py-clob-client web3==6.14.0"}))
        sys.exit(1)

    def get_client(private_key):
        client = ClobClient(
            "https://clob.polymarket.com",
            key=private_key,
            chain_id=137,
            signature_type=0,  # EOA
        )
        client.set_api_creds(client.create_or_derive_api_creds())
        return client

    try:
        if cmd == "buy" or cmd == "sell":
            token_id = sys.argv[2]
            price = float(sys.argv[3])
            size = float(sys.argv[4])
            private_key = sys.argv[5]

            client = get_client(private_key)
            side = BUY if cmd == "buy" else SELL

            order = OrderArgs(
                token_id=token_id,
                price=price,
                size=size,
                side=side,
            )
            signed = client.create_order(order)
            resp = client.post_order(signed, OrderType.GTC)
            print(json.dumps({"ok": True, "order": resp, "side": cmd, "price": price, "size": size}))

        elif cmd == "market_buy":
            token_id = sys.argv[2]
            amount = float(sys.argv[3])
            private_key = sys.argv[4]

            client = get_client(private_key)
            order = MarketOrderArgs(
                token_id=token_id,
                amount=amount,
                side=BUY,
            )
            signed = client.create_market_order(order)
            resp = client.post_order(signed, OrderType.FOK)
            print(json.dumps({"ok": True, "order": resp, "amount": amount}))

        elif cmd == "cancel":
            order_id = sys.argv[2]
            private_key = sys.argv[3]

            client = get_client(private_key)
            resp = client.cancel(order_id)
            print(json.dumps({"ok": True, "cancelled": order_id}))

        elif cmd == "cancel_all":
            private_key = sys.argv[2]
            client = get_client(private_key)
            resp = client.cancel_all()
            print(json.dumps({"ok": True, "cancelled": "all"}))

        elif cmd == "balance":
            private_key = sys.argv[2]
            from web3 import Web3
            w3 = Web3(Web3.HTTPProvider("https://polygon-rpc.com"))
            account = w3.eth.account.from_key(private_key)

            # USDC on Polygon
            usdc = w3.eth.contract(
                address=Web3.to_checksum_address("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),
                abi=[{"inputs":[{"name":"account","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}],
            )
            balance = usdc.functions.balanceOf(account.address).call()
            matic = w3.eth.get_balance(account.address)

            print(json.dumps({
                "ok": True,
                "address": account.address,
                "usdc": balance / 1e6,
                "matic": float(w3.from_wei(matic, "ether")),
            }))

        elif cmd == "positions":
            private_key = sys.argv[2]
            client = get_client(private_key)
            # Get open orders as proxy for positions
            orders = client.get_orders(OpenOrderParams())
            print(json.dumps({"ok": True, "orders": orders}))

        elif cmd == "approve":
            private_key = sys.argv[2]
            client = get_client(private_key)
            # Approve USDC spending for exchange contracts
            resp = client.approve_all()
            print(json.dumps({"ok": True, "approved": True}))

        else:
            print(json.dumps({"error": f"Unknown command: {cmd}"}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
