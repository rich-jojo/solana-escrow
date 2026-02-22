#!/usr/bin/env bash
# Retry devnet airdrop with exponential backoff.
# Usage: ./scripts/retry-airdrop.sh [amount_sol] [max_retries]

set -euo pipefail

source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"

AMOUNT="${1:-2}"
MAX_RETRIES="${2:-20}"
DELAY=30

solana config set --url devnet >/dev/null 2>&1

echo "Requesting $AMOUNT SOL airdrop (max $MAX_RETRIES retries, ${DELAY}s between)..."

for i in $(seq 1 $MAX_RETRIES); do
    echo -n "Attempt $i/$MAX_RETRIES: "
    if solana airdrop "$AMOUNT" 2>&1; then
        BALANCE=$(solana balance | awk '{print $1}')
        echo "Success! Balance: $BALANCE SOL"
        exit 0
    fi
    
    if [ "$i" -lt "$MAX_RETRIES" ]; then
        echo "  Waiting ${DELAY}s..."
        sleep "$DELAY"
        # Increase delay slightly
        DELAY=$((DELAY + 10))
    fi
done

echo "Failed after $MAX_RETRIES attempts."
echo "Try manually at: https://faucet.solana.com"
exit 1
