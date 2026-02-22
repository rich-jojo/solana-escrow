# Solana Escrow Engine

A production-quality on-chain escrow system built with the [Anchor](https://www.anchor-lang.com/) framework on Solana. Enables trustless SPL token exchanges between a buyer and seller, with built-in deadline enforcement and cancellation support.

## Web2 vs Solana Escrow: A Comparison

| Aspect | Web2 Escrow | Solana On-Chain Escrow |
|--------|------------|----------------------|
| **Trust Model** | Centralized intermediary holds funds (PayPal, Stripe, bank). Users trust the company. | Trustless — funds are held by a deterministic Program Derived Address (PDA). No company or person controls them. |
| **Custody** | Escrow service has full control of deposited funds. Can freeze, reverse, or delay payouts. | Funds sit in a PDA vault. Only the program logic (auditable, immutable code) can move them. |
| **Transparency** | Internal database records. Users cannot independently verify fund status. | Fully on-chain. Anyone can query the escrow account and vault balance in real time via Solana explorers. |
| **Settlement Speed** | 1–5 business days for bank transfers, instant for in-platform credits. | ~400ms finality. Funds are available to the seller immediately after buyer releases. |
| **Fees** | 2–5% platform fee + payment processor fees + potential FX charges. | ~$0.001 per transaction (Solana network fee). No platform fee in this implementation. |
| **Availability** | Platform uptime dependent. Subject to maintenance windows, region restrictions, and business hours. | 24/7/365. Solana network has no downtime windows and no geographic restrictions. |
| **Dispute Resolution** | Human arbitrators review disputes. Can take days to weeks. | Deterministic rules only (buyer controls release/cancel). For production: extend with multi-sig arbitration or DAO governance. |
| **Reversibility** | Chargebacks, refunds, and admin overrides are possible. | Irreversible once released. Cancel returns funds to buyer before release. No admin backdoor. |
| **Token Support** | Fiat currencies, sometimes crypto via payment processors. | Any SPL token (USDC, USDT, SOL wrapped, custom tokens). Compatible with Token-2022 extensions. |
| **Regulatory** | Must comply with KYC/AML, payment regulations, money transmitter licenses. | Permissionless protocol. Compliance is at the application layer, not the smart contract layer. |

### When to Choose Each

- **Web2 Escrow**: When you need fiat currency support, dispute arbitration by humans, regulatory compliance out of the box, or when your users don't have crypto wallets.
- **Solana Escrow**: When you need trustless guarantees, near-instant settlement, minimal fees, 24/7 availability, support for any SPL token, or when operating in regions underserved by traditional payment processors.

## Architecture

### Accounts

- **Escrow PDA** — Stores the deal metadata: buyer, seller, token mint, amount, deadline, and state. Seeds: `["escrow", buyer, seller, mint]`.
- **Vault PDA** — SPL token account that holds the escrowed tokens. Authority is the vault itself (self-referential PDA), so only the program can authorize transfers. Seeds: `["vault", escrow_key]`.

### Instructions

| Instruction | Signer | Description |
|------------|--------|-------------|
| `initialize(amount, deadline)` | Buyer | Creates escrow + vault PDAs, transfers `amount` tokens from buyer to vault. |
| `release()` | Buyer | Transfers tokens from vault to seller. Marks escrow as `Released`. |
| `cancel()` | Buyer | Returns tokens from vault to buyer. Marks escrow as `Cancelled`. |

### State Machine

```
  ┌──────────┐
  │  (init)  │
  └────┬─────┘
       │ initialize()
       ▼
  ┌──────────┐
  │  Locked  │
  └──┬────┬──┘
     │    │
     │    │ cancel()
     │    ▼
     │  ┌───────────┐
     │  │ Cancelled │
     │  └───────────┘
     │
     │ release()
     ▼
  ┌──────────┐
  │ Released │
  └──────────┘
```

### Safety Features

- **Zero-amount guard**: Rejects escrow creation with 0 tokens.
- **Deadline validation**: Must be in the future and within 90 days.
- **State machine enforcement**: Release and cancel only work on `Locked` escrows — prevents double-spend.
- **PDA authority**: Vault uses self-referential authority — no external keypair can drain it.
- **has_one constraints**: Buyer identity verified via Anchor's `has_one` check.
- **Token Interface**: Uses `token_interface` for compatibility with both SPL Token and Token-2022.

## Getting Started

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (1.85+)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) (3.1+)
- [Anchor](https://www.anchor-lang.com/docs/installation) (0.32.1)
- [Node.js](https://nodejs.org/) (20+)
- [Yarn](https://yarnpkg.com/)

### Build

```bash
anchor build
```

### Test

Tests run against a local validator automatically:

```bash
anchor test
```

8 tests cover the full lifecycle:
- ✅ Escrow initialization with token deposit
- ✅ Zero-amount rejection
- ✅ Past-deadline rejection
- ✅ Buyer releases funds to seller
- ✅ Non-buyer release rejection (authorization)
- ✅ Double-release prevention
- ✅ Buyer cancels and reclaims funds
- ✅ Cancel-after-release prevention

### Deploy to Devnet

```bash
# Configure for devnet
solana config set --url https://api.devnet.solana.com

# Get devnet SOL
solana airdrop 2

# Deploy
anchor deploy --provider.cluster devnet
```

### CLI Usage

After deployment, interact with the escrow via the Anchor TypeScript client:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { SolanaEscrow } from "./target/types/solana_escrow";

// Initialize escrow: deposit 100 tokens with 1-hour deadline
await program.methods
  .initialize(new BN(100_000_000), new BN(deadline))
  .accounts({ buyer, seller, mint, buyerTokenAccount, escrow, vault, tokenProgram, systemProgram })
  .signers([buyerKeypair])
  .rpc();

// Release: buyer approves, seller receives tokens
await program.methods
  .release()
  .accounts({ buyer, mint, escrow, vault, sellerTokenAccount, tokenProgram })
  .signers([buyerKeypair])
  .rpc();

// Cancel: buyer reclaims tokens
await program.methods
  .cancel()
  .accounts({ buyer, mint, escrow, vault, buyerTokenAccount, tokenProgram })
  .signers([buyerKeypair])
  .rpc();
```

## Project Structure

```
solana-escrow/
├── programs/solana-escrow/src/
│   └── lib.rs              # Escrow program (initialize, release, cancel)
├── tests/
│   └── solana-escrow.ts    # 8 comprehensive TypeScript tests
├── Anchor.toml             # Anchor configuration
├── Cargo.toml              # Rust workspace
└── README.md               # This file
```

## License

MIT
