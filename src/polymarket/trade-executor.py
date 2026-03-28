#!/usr/bin/env python3
"""
Polymarket Trade Executor — Real orders via py-clob-client

Commands:
  buy       <token_id> <price> <size> <private_key> [neg_risk]
  sell      <token_id> <price> <size> <private_key> [neg_risk]
  market_buy <token_id> <amount_usd> <private_key>
  cancel    <order_id> <private_key>
  cancel_all <private_key>
  balance   <private_key>
  positions <private_key>
  approve   <private_key>
  open_orders <private_key>
  tick_size <token_id>

Output: JSON to stdout
"""
import sys
import json
import os

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: trade-executor.py <command> [args...]"}))
        sys.exit(1)

    cmd = sys.argv[1]

    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import OrderArgs, MarketOrderArgs, OrderType, OpenOrderParams
        from py_clob_client.order_builder.constants import BUY, SELL
    except ImportError as e:
        print(json.dumps({"error": f"Missing dependency: {e}. Run: pip3 install py-clob-client web3==6.14.0"}))
        sys.exit(1)

    def get_client(private_key):
        client = ClobClient(
            "https://clob.polymarket.com",
            key=private_key,
            chain_id=137,
            signature_type=0,  # EOA wallet
        )
        # Derive or create API credentials
        creds = client.create_or_derive_api_creds()
        client.set_api_creds(creds)
        return client

    try:
        # ── Limit Order (GTC) ────────────────────────────────
        if cmd in ("buy", "sell"):
            token_id = sys.argv[2]
            price = float(sys.argv[3])
            size = float(sys.argv[4])
            private_key = sys.argv[5]
            neg_risk = len(sys.argv) > 6 and sys.argv[6] == "true"

            client = get_client(private_key)
            side = BUY if cmd == "buy" else SELL

            # Get tick size for proper price rounding
            tick_size = "0.01"
            try:
                neg_risk_flag = client.get_neg_risk(token_id) if hasattr(client, 'get_neg_risk') else neg_risk
            except:
                neg_risk_flag = neg_risk

            order_args = OrderArgs(
                token_id=token_id,
                price=price,
                size=size,
                side=side,
            )

            signed = client.create_order(order_args)
            resp = client.post_order(signed, OrderType.GTC)

            print(json.dumps({
                "ok": True,
                "order_id": resp.get("orderID", resp.get("id", "unknown")),
                "side": cmd.upper(),
                "price": price,
                "size": size,
                "token_id": token_id,
            }))

        # ── Market Order (FOK) ───────────────────────────────
        elif cmd == "market_buy":
            token_id = sys.argv[2]
            amount = float(sys.argv[3])
            private_key = sys.argv[4]

            client = get_client(private_key)

            order_args = MarketOrderArgs(
                token_id=token_id,
                amount=amount,
                side=BUY,
            )

            signed = client.create_market_order(order_args)
            resp = client.post_order(signed, OrderType.FOK)

            print(json.dumps({
                "ok": True,
                "order_id": resp.get("orderID", "unknown"),
                "side": "MARKET_BUY",
                "amount_usd": amount,
            }))

        # ── Market Sell (FOK) ────────────────────────────────
        elif cmd == "market_sell":
            token_id = sys.argv[2]
            amount = float(sys.argv[3])
            private_key = sys.argv[4]

            client = get_client(private_key)

            order_args = MarketOrderArgs(
                token_id=token_id,
                amount=amount,
                side=SELL,
            )

            signed = client.create_market_order(order_args)
            resp = client.post_order(signed, OrderType.FOK)

            print(json.dumps({
                "ok": True,
                "order_id": resp.get("orderID", "unknown"),
                "side": "MARKET_SELL",
                "amount_usd": amount,
            }))

        # ── Cancel Order ─────────────────────────────────────
        elif cmd == "cancel":
            order_id = sys.argv[2]
            private_key = sys.argv[3]
            client = get_client(private_key)
            resp = client.cancel(order_id)
            print(json.dumps({"ok": True, "cancelled": order_id}))

        # ── Cancel All ───────────────────────────────────────
        elif cmd == "cancel_all":
            private_key = sys.argv[2]
            client = get_client(private_key)
            resp = client.cancel_all()
            print(json.dumps({"ok": True, "cancelled": "all"}))

        # ── Balance ──────────────────────────────────────────
        elif cmd == "balance":
            private_key = sys.argv[2]
            from eth_account import Account
            from web3 import Web3

            account = Account.from_key(private_key)
            w3 = Web3(Web3.HTTPProvider("https://polygon-rpc.com"))

            # USDC balance
            usdc_abi = [{"constant":True,"inputs":[{"name":"_owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"balance","type":"uint256"}],"type":"function"}]
            usdc = w3.eth.contract(
                address=Web3.to_checksum_address("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),
                abi=usdc_abi,
            )
            usdc_balance = usdc.functions.balanceOf(account.address).call()
            matic_balance = w3.eth.get_balance(account.address)

            print(json.dumps({
                "ok": True,
                "address": account.address,
                "usdc": usdc_balance / 1e6,
                "matic": float(Web3.from_wei(matic_balance, "ether")),
            }))

        # ── Open Orders ──────────────────────────────────────
        elif cmd == "open_orders":
            private_key = sys.argv[2]
            client = get_client(private_key)
            orders = client.get_orders(OpenOrderParams())
            print(json.dumps({"ok": True, "orders": orders}))

        # ── Approve Spending ─────────────────────────────────
        elif cmd == "approve":
            private_key = sys.argv[2]
            client = get_client(private_key)

            # Approve USDC for all exchange contracts
            from web3 import Web3
            from eth_account import Account

            w3 = Web3(Web3.HTTPProvider("https://polygon-rpc.com"))
            account = Account.from_key(private_key)

            usdc_address = Web3.to_checksum_address("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174")
            max_approval = 2**256 - 1

            exchanges = [
                "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",  # CTF Exchange
                "0xC5d563A36AE78145C45a50134d48A1215220f80a",  # NegRisk Exchange
                "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",  # NegRisk Adapter
            ]

            approve_abi = [{"constant":False,"inputs":[{"name":"_spender","type":"address"},{"name":"_value","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"type":"function"}]
            usdc = w3.eth.contract(address=usdc_address, abi=approve_abi)

            tx_hashes = []
            for exchange in exchanges:
                nonce = w3.eth.get_transaction_count(account.address)
                tx = usdc.functions.approve(
                    Web3.to_checksum_address(exchange), max_approval
                ).build_transaction({
                    "from": account.address,
                    "nonce": nonce + len(tx_hashes),
                    "gas": 100000,
                    "gasPrice": w3.eth.gas_price,
                    "chainId": 137,
                })
                signed_tx = w3.eth.account.sign_transaction(tx, private_key)
                tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
                tx_hashes.append(tx_hash.hex())

            print(json.dumps({
                "ok": True,
                "approved": True,
                "exchanges": len(exchanges),
                "tx_hashes": tx_hashes,
            }))

        # ── Tick Size ────────────────────────────────────────
        elif cmd == "tick_size":
            token_id = sys.argv[2]
            import requests
            resp = requests.get(f"https://clob.polymarket.com/tick-size?token_id={token_id}")
            data = resp.json()
            print(json.dumps({"ok": True, "tick_size": data.get("minimum_tick_size", "0.01")}))

        else:
            print(json.dumps({"error": f"Unknown command: {cmd}"}))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({"error": str(e)[:500]}))
        sys.exit(1)

if __name__ == "__main__":
    main()
