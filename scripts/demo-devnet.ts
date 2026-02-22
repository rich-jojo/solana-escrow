/**
 * Demo script: creates an escrow, releases it, and cancels another one on devnet.
 * Outputs transaction signatures with explorer links.
 *
 * Usage: npx ts-node scripts/demo-devnet.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { SolanaEscrow } from "../target/types/solana_escrow";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Connection } from "@solana/web3.js";
import * as fs from "fs";

const EXPLORER_BASE = "https://explorer.solana.com/tx";
const CLUSTER = "devnet";
const DECIMALS = 6;
const ESCROW_AMOUNT = 1_000_000; // 1 token

function explorerLink(sig: string): string {
  return `${EXPLORER_BASE}/${sig}?cluster=${CLUSTER}`;
}

async function main() {
  // Connect to devnet
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Load wallet from default keypair
  const walletKeyfile = fs.readFileSync(
    `${process.env.HOME}/.config/solana/id.json`,
    "utf-8"
  );
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(walletKeyfile))
  );

  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.solanaEscrow as Program<SolanaEscrow>;
  const results: { action: string; signature: string; link: string }[] = [];

  console.log("Payer:", walletKeypair.publicKey.toString());
  console.log("Program:", program.programId.toString());
  console.log("");

  // ─── Setup: create mint, buyer/seller keypairs, token accounts ───
  const buyer = Keypair.generate();
  const seller = Keypair.generate();

  // Fund buyer with SOL for tx fees
  console.log("Funding buyer with SOL...");
  const airdropSig = await connection.requestAirdrop(
    buyer.publicKey,
    2 * anchor.web3.LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(airdropSig);

  // Create SPL token mint
  console.log("Creating SPL token mint...");
  const mint = await createMint(
    connection,
    buyer,
    buyer.publicKey,
    null,
    DECIMALS,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log("Mint:", mint.toString());

  // Create token accounts
  const buyerTokenAccount = await createAccount(
    connection,
    buyer,
    mint,
    buyer.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  const sellerTokenAccount = await createAccount(
    connection,
    buyer,
    mint,
    seller.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  // Mint tokens to buyer (enough for two escrows)
  await mintTo(
    connection,
    buyer,
    mint,
    buyerTokenAccount,
    buyer,
    ESCROW_AMOUNT * 5,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log("Minted", ESCROW_AMOUNT * 5, "tokens to buyer");
  console.log("");

  // ─── Helper: derive PDAs ───
  function getEscrowPDA(
    buyerPk: PublicKey,
    sellerPk: PublicKey,
    mintPk: PublicKey
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        buyerPk.toBuffer(),
        sellerPk.toBuffer(),
        mintPk.toBuffer(),
      ],
      program.programId
    );
    return pda;
  }

  function getVaultPDA(escrowPk: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPk.toBuffer()],
      program.programId
    );
    return pda;
  }

  // ─── Demo 1: Initialize → Release (happy path) ───
  console.log("=== Demo 1: Initialize escrow and release to seller ===");

  const escrow1 = getEscrowPDA(buyer.publicKey, seller.publicKey, mint);
  const vault1 = getVaultPDA(escrow1);
  const deadline1 = new BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour

  // Initialize
  const initSig = await program.methods
    .initialize(new BN(ESCROW_AMOUNT), deadline1)
    .accounts({
      buyer: buyer.publicKey,
      seller: seller.publicKey,
      mint: mint,
      buyerTokenAccount: buyerTokenAccount,
      escrow: escrow1,
      vault: vault1,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([buyer])
    .rpc();

  results.push({
    action: "initialize (Demo 1)",
    signature: initSig,
    link: explorerLink(initSig),
  });
  console.log("Initialize tx:", initSig);
  console.log("  →", explorerLink(initSig));

  // Verify vault balance
  const vaultAccount1 = await getAccount(connection, vault1);
  console.log("Vault balance:", Number(vaultAccount1.amount), "tokens");

  // Release
  const releaseSig = await program.methods
    .release()
    .accounts({
      buyer: buyer.publicKey,
      mint: mint,
      escrow: escrow1,
      vault: vault1,
      sellerTokenAccount: sellerTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([buyer])
    .rpc();

  results.push({
    action: "release (Demo 1)",
    signature: releaseSig,
    link: explorerLink(releaseSig),
  });
  console.log("Release tx:", releaseSig);
  console.log("  →", explorerLink(releaseSig));

  // Verify seller received tokens
  const sellerAccount = await getAccount(connection, sellerTokenAccount);
  console.log("Seller balance:", Number(sellerAccount.amount), "tokens ✓");
  console.log("");

  // ─── Demo 2: Initialize → Cancel (refund path) ───
  // Need a different seller to get a different PDA
  const seller2 = Keypair.generate();
  const sellerTokenAccount2 = await createAccount(
    connection,
    buyer,
    mint,
    seller2.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  console.log("=== Demo 2: Initialize escrow and cancel (refund) ===");

  const escrow2 = getEscrowPDA(buyer.publicKey, seller2.publicKey, mint);
  const vault2 = getVaultPDA(escrow2);
  const deadline2 = new BN(Math.floor(Date.now() / 1000) + 7200); // 2 hours

  // Initialize
  const initSig2 = await program.methods
    .initialize(new BN(ESCROW_AMOUNT), deadline2)
    .accounts({
      buyer: buyer.publicKey,
      seller: seller2.publicKey,
      mint: mint,
      buyerTokenAccount: buyerTokenAccount,
      escrow: escrow2,
      vault: vault2,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([buyer])
    .rpc();

  results.push({
    action: "initialize (Demo 2 - cancel)",
    signature: initSig2,
    link: explorerLink(initSig2),
  });
  console.log("Initialize tx:", initSig2);
  console.log("  →", explorerLink(initSig2));

  // Get buyer balance before cancel
  const buyerBefore = await getAccount(connection, buyerTokenAccount);
  const balanceBefore = Number(buyerBefore.amount);

  // Cancel
  const cancelSig = await program.methods
    .cancel()
    .accounts({
      buyer: buyer.publicKey,
      mint: mint,
      escrow: escrow2,
      vault: vault2,
      buyerTokenAccount: buyerTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([buyer])
    .rpc();

  results.push({
    action: "cancel (Demo 2)",
    signature: cancelSig,
    link: explorerLink(cancelSig),
  });
  console.log("Cancel tx:", cancelSig);
  console.log("  →", explorerLink(cancelSig));

  // Verify buyer got tokens back
  const buyerAfter = await getAccount(connection, buyerTokenAccount);
  console.log(
    "Buyer balance after cancel:",
    Number(buyerAfter.amount),
    "tokens (refunded",
    Number(buyerAfter.amount) - balanceBefore,
    ") ✓"
  );

  // ─── Summary ───
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("                  TRANSACTION SUMMARY                  ");
  console.log("═══════════════════════════════════════════════════════");
  for (const r of results) {
    console.log(`${r.action}:`);
    console.log(`  Sig:  ${r.signature}`);
    console.log(`  Link: ${r.link}`);
    console.log("");
  }

  // Write results to file for submission
  const output = {
    program_id: program.programId.toString(),
    program_explorer: `https://explorer.solana.com/address/${program.programId.toString()}?cluster=devnet`,
    transactions: results,
    demo_accounts: {
      buyer: buyer.publicKey.toString(),
      seller: seller.publicKey.toString(),
      seller2: seller2.publicKey.toString(),
      mint: mint.toString(),
    },
  };

  fs.writeFileSync(
    `${__dirname}/../devnet-demo-results.json`,
    JSON.stringify(output, null, 2)
  );
  console.log("Results saved to devnet-demo-results.json");
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
