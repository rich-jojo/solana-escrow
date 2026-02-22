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

## Design Deep Dive: Web2 → Solana Translation

### How This Works in Web2

A typical backend escrow service looks like this:

```
Client → REST API → EscrowService → Database (PostgreSQL)
                                   → PaymentGateway (Stripe/PayPal)
```

**State**: A row in `escrows` table with columns `id`, `buyer_id`, `seller_id`, `amount`, `currency`, `status`, `created_at`, `deadline`.

**Trust**: The server process has full DB access. An admin or compromised server can modify any escrow row. Fund custody relies on the payment gateway's API and the company's bank account.

**Authorization**: JWT/session tokens → middleware checks `req.user.id === escrow.buyer_id`. A bug in auth middleware = catastrophic access control failure.

**Atomicity**: Database transactions (`BEGIN; UPDATE escrows SET status='released'; INSERT INTO transfers ...; COMMIT;`). Relies on DB engine correctness.

### How This Works on Solana

```
Client → RPC → Solana Runtime → EscrowProgram (BPF bytecode)
                                → Accounts (on-chain state)
```

**State**: `Escrow` account (PDA) containing `buyer: Pubkey, seller: Pubkey, amount: u64, state: enum`. Each escrow is a separate account, not a row in a shared table. No shared mutable state means no row-level locking concerns.

**Trust**: The program is deployed as immutable bytecode (or upgrade-authority controlled). The vault PDA has no private key — literally no entity can extract funds outside the program's logic. Trust shifts from "do I trust this company?" to "have I audited this ~300-line program?".

**Authorization**: The Solana runtime itself enforces signer verification. `Signer<'info>` + PDA seeds mean authorization is cryptographic, not application-level. There's no equivalent of a "broken auth middleware" — the signature is either valid or the transaction is rejected before your code runs.

**Atomicity**: Every Solana transaction is atomic by the runtime. If any instruction fails, the entire transaction reverts — including all account state changes and token transfers. No manual rollback logic needed.

### Account Model Translation

| Web2 Concept | Solana Equivalent | Key Difference |
|-------------|-------------------|----------------|
| Database row | Account (PDA) | Each escrow is an independent account, not a row in a table. Solana parallelizes across accounts. |
| Auto-increment ID | PDA seeds `[buyer, seller, mint]` | Deterministic addressing. Anyone can compute the escrow address offline. |
| Foreign key → users table | `Pubkey` stored in account | No JOIN needed. Buyer/seller are just public keys verified by signatures. |
| Admin panel / service account | Upgrade authority | Can be set to `null` for full immutability. No equivalent of "admin resets password". |
| Payment gateway vault | Token account PDA | Self-referential authority. The vault PDA's authority is itself — no private key exists. |
| Database connection pool | Account lookup (RPC) | Accounts are fetched via `getProgramAccounts`. No connection limit concerns. |

## Tradeoffs & Constraints

### Advantages of the On-Chain Approach

1. **Elimination of counterparty risk**: No company can freeze, delay, or misappropriate escrowed funds. The PDA vault has no private key.
2. **Composability**: Other Solana programs can CPI (Cross-Program Invoke) into this escrow. Enables building payment flows, marketplaces, or DAOs on top without API integrations.
3. **Auditability**: ~300 lines of open-source Rust vs. thousands of lines of backend + infra code. The entire security surface is visible.
4. **Global accessibility**: No KYC/region gates at the protocol level. Anyone with a Solana wallet can use the escrow.
5. **Near-zero cost**: ~$0.001 per transaction vs. 2-5% payment processor fees.

### Constraints & Limitations

1. **No human dispute resolution**: This implementation is buyer-controlled (buyer releases or cancels). A malicious buyer can indefinitely withhold release. Production systems should add:
   - Multi-sig arbitration (buyer + seller + arbiter, 2-of-3)
   - Automatic release after deadline if buyer doesn't cancel
   - DAO-based dispute resolution

2. **One escrow per buyer-seller-mint triple**: PDA seeds `[buyer, seller, mint]` mean a buyer can only have one active escrow with the same seller for the same token. Fix: add a `nonce` or `escrow_id` seed.

3. **No partial release**: The entire amount must be released or cancelled. Real escrow systems often need milestones (release 30% on delivery, 70% on acceptance). Solvable by adding milestone state.

4. **Rent costs**: Creating the escrow + vault accounts requires ~0.003 SOL in rent. This is recoverable by closing accounts (not implemented to keep the code focused).

5. **Account size is fixed**: Unlike a database row that grows dynamically, Solana accounts must declare size upfront. The `Escrow` struct is ~138 bytes, which is efficient but means adding fields requires migration.

6. **Clock dependency**: `Clock::get()` returns cluster time, which validators can skew slightly (~1-2 seconds). Not suitable for millisecond-precision deadlines, but fine for hour/day granularity.

7. **Token-specific**: Only handles SPL tokens (including Token-2022). Native SOL escrow would need a different design (wrapping SOL → wSOL or using system program transfers).

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

# Build and deploy
anchor build
anchor deploy --provider.cluster devnet

# Run demo (creates escrow, demonstrates release + cancel, outputs tx links)
npx ts-node scripts/demo-devnet.ts
```

Or use the automated deployment script:

```bash
./scripts/deploy-devnet.sh
```

### CLI Usage

Interact with the escrow via the Anchor TypeScript client:

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
│   └── lib.rs                # Escrow program (initialize, release, cancel)
├── tests/
│   └── solana-escrow.ts      # 8 comprehensive TypeScript tests
├── scripts/
│   ├── deploy-devnet.sh      # Automated devnet deployment
│   └── demo-devnet.ts        # Demo: create, release, cancel escrows
├── Anchor.toml               # Anchor configuration
├── Cargo.toml                # Rust workspace
└── README.md                 # This file
```

## License

MIT
