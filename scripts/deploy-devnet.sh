#!/usr/bin/env bash
# Deploy solana-escrow to devnet and run demo transactions.
# Prerequisites: Solana CLI, Anchor CLI, Yarn, funded devnet wallet (~3 SOL).
#
# Usage: ./scripts/deploy-devnet.sh
#
# Outputs:
#   - Program ID (on-chain address)
#   - Demo transaction signatures for initialize, release, and cancel
#   - All transaction links on Solana Explorer

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Ensure toolchain is in PATH
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"

echo "=== Solana Escrow Devnet Deployment ==="
echo ""

# 1. Check balance
BALANCE=$(solana balance --url devnet | awk '{print $1}')
echo "Current devnet balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 2" | bc -l) )); then
    echo "ERROR: Need at least 2 SOL for deployment + demo. Current: $BALANCE SOL"
    echo "Run: solana airdrop 2 --url devnet"
    echo "Or visit: https://faucet.solana.com"
    exit 1
fi

# 2. Build
echo ""
echo "=== Building program ==="
cd "$PROJECT_DIR"
anchor build

# 3. Get program keypair and update program ID if needed
PROGRAM_KEYPAIR="$PROJECT_DIR/target/deploy/solana_escrow-keypair.json"
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
echo "Program ID: $PROGRAM_ID"

# Update declare_id! in lib.rs if different
CURRENT_ID=$(grep 'declare_id!' "$PROJECT_DIR/programs/solana-escrow/src/lib.rs" | sed 's/.*"\(.*\)".*/\1/')
if [ "$CURRENT_ID" != "$PROGRAM_ID" ]; then
    echo "Updating program ID from $CURRENT_ID to $PROGRAM_ID"
    sed -i "s/$CURRENT_ID/$PROGRAM_ID/g" "$PROJECT_DIR/programs/solana-escrow/src/lib.rs"
    sed -i "s/$CURRENT_ID/$PROGRAM_ID/g" "$PROJECT_DIR/Anchor.toml"
    anchor build  # Rebuild with new ID
fi

# 4. Deploy
echo ""
echo "=== Deploying to devnet ==="
DEPLOY_OUTPUT=$(anchor deploy --provider.cluster devnet 2>&1)
echo "$DEPLOY_OUTPUT"
echo ""
echo "Program deployed: $PROGRAM_ID"
echo "Explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"

# 5. Run demo script
echo ""
echo "=== Running demo transactions ==="
npx ts-node "$SCRIPT_DIR/demo-devnet.ts"

echo ""
echo "=== Deployment complete ==="
echo "Program ID: $PROGRAM_ID"
echo "Explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
