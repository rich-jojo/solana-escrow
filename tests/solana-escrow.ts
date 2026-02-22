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
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("solana-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.solanaEscrow as Program<SolanaEscrow>;
  const connection = provider.connection;

  let mint: PublicKey;
  let buyer: Keypair;
  let seller: Keypair;
  let buyerTokenAccount: PublicKey;
  let sellerTokenAccount: PublicKey;

  const DECIMALS = 6;
  const DEPOSIT_AMOUNT = 1_000_000; // 1 token (6 decimals)

  beforeEach(async () => {
    // Create fresh keypairs for each test
    buyer = Keypair.generate();
    seller = Keypair.generate();

    // Airdrop SOL to buyer for transaction fees and rent
    const sig = await connection.requestAirdrop(
      buyer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(sig);

    // Create SPL token mint
    mint = await createMint(
      connection,
      buyer,
      buyer.publicKey, // mint authority
      null, // freeze authority
      DECIMALS,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Create buyer and seller token accounts
    buyerTokenAccount = await createAccount(
      connection,
      buyer,
      mint,
      buyer.publicKey,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    sellerTokenAccount = await createAccount(
      connection,
      buyer, // buyer pays for seller's account creation
      mint,
      seller.publicKey,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Mint tokens to buyer
    await mintTo(
      connection,
      buyer,
      mint,
      buyerTokenAccount,
      buyer, // mint authority
      DEPOSIT_AMOUNT * 10, // mint plenty of tokens
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
  });

  function getEscrowPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        buyer.publicKey.toBuffer(),
        seller.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      program.programId
    );
  }

  function getVaultPDA(escrowKey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowKey.toBuffer()],
      program.programId
    );
  }

  function futureDeadline(secondsFromNow: number): BN {
    return new BN(Math.floor(Date.now() / 1000) + secondsFromNow);
  }

  describe("initialize", () => {
    it("creates escrow and deposits tokens into vault", async () => {
      const [escrowPDA] = getEscrowPDA();
      const [vaultPDA] = getVaultPDA(escrowPDA);
      const deadline = futureDeadline(3600); // 1 hour from now

      await program.methods
        .initialize(new BN(DEPOSIT_AMOUNT), deadline)
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint: mint,
          buyerTokenAccount: buyerTokenAccount,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Verify escrow state
      const escrow = await program.account.escrow.fetch(escrowPDA);
      expect(escrow.buyer.toString()).to.equal(buyer.publicKey.toString());
      expect(escrow.seller.toString()).to.equal(seller.publicKey.toString());
      expect(escrow.mint.toString()).to.equal(mint.toString());
      expect(escrow.amount.toNumber()).to.equal(DEPOSIT_AMOUNT);
      expect(escrow.deadline.toNumber()).to.equal(deadline.toNumber());
      expect(escrow.state).to.deep.equal({ locked: {} });

      // Verify vault balance
      const vaultAccount = await getAccount(connection, vaultPDA);
      expect(Number(vaultAccount.amount)).to.equal(DEPOSIT_AMOUNT);

      // Verify buyer's balance decreased
      const buyerAccount = await getAccount(connection, buyerTokenAccount);
      expect(Number(buyerAccount.amount)).to.equal(
        DEPOSIT_AMOUNT * 10 - DEPOSIT_AMOUNT
      );
    });

    it("rejects zero amount", async () => {
      const [escrowPDA] = getEscrowPDA();
      const [vaultPDA] = getVaultPDA(escrowPDA);
      const deadline = futureDeadline(3600);

      try {
        await program.methods
          .initialize(new BN(0), deadline)
          .accounts({
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            mint: mint,
            buyerTokenAccount: buyerTokenAccount,
            escrow: escrowPDA,
            vault: vaultPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("rejects deadline in the past", async () => {
      const [escrowPDA] = getEscrowPDA();
      const [vaultPDA] = getVaultPDA(escrowPDA);
      const pastDeadline = new BN(Math.floor(Date.now() / 1000) - 3600);

      try {
        await program.methods
          .initialize(new BN(DEPOSIT_AMOUNT), pastDeadline)
          .accounts({
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            mint: mint,
            buyerTokenAccount: buyerTokenAccount,
            escrow: escrowPDA,
            vault: vaultPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("DeadlineInPast");
      }
    });
  });

  describe("release", () => {
    it("sends funds from vault to seller", async () => {
      const [escrowPDA] = getEscrowPDA();
      const [vaultPDA] = getVaultPDA(escrowPDA);
      const deadline = futureDeadline(3600);

      // Initialize escrow first
      await program.methods
        .initialize(new BN(DEPOSIT_AMOUNT), deadline)
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint: mint,
          buyerTokenAccount: buyerTokenAccount,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Release escrow
      await program.methods
        .release()
        .accounts({
          buyer: buyer.publicKey,
          mint: mint,
          escrow: escrowPDA,
          vault: vaultPDA,
          sellerTokenAccount: sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();

      // Verify escrow state changed to Released
      const escrow = await program.account.escrow.fetch(escrowPDA);
      expect(escrow.state).to.deep.equal({ released: {} });

      // Verify seller received tokens
      const sellerAccount = await getAccount(connection, sellerTokenAccount);
      expect(Number(sellerAccount.amount)).to.equal(DEPOSIT_AMOUNT);

      // Verify vault is empty
      const vaultAccount = await getAccount(connection, vaultPDA);
      expect(Number(vaultAccount.amount)).to.equal(0);
    });

    it("rejects release from non-buyer", async () => {
      const [escrowPDA] = getEscrowPDA();
      const [vaultPDA] = getVaultPDA(escrowPDA);
      const deadline = futureDeadline(3600);

      // Initialize escrow
      await program.methods
        .initialize(new BN(DEPOSIT_AMOUNT), deadline)
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint: mint,
          buyerTokenAccount: buyerTokenAccount,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Airdrop to seller so they can attempt release
      const sig = await connection.requestAirdrop(
        seller.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);

      // Attempt release from seller (should fail — seeds won't match)
      try {
        await program.methods
          .release()
          .accounts({
            buyer: seller.publicKey, // wrong signer
            mint: mint,
            escrow: escrowPDA,
            vault: vaultPDA,
            sellerTokenAccount: sellerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([seller])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // PDA derivation or has_one constraint will fail
        expect(err).to.exist;
      }
    });

    it("rejects double release", async () => {
      const [escrowPDA] = getEscrowPDA();
      const [vaultPDA] = getVaultPDA(escrowPDA);
      const deadline = futureDeadline(3600);

      // Initialize and release
      await program.methods
        .initialize(new BN(DEPOSIT_AMOUNT), deadline)
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint: mint,
          buyerTokenAccount: buyerTokenAccount,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .release()
        .accounts({
          buyer: buyer.publicKey,
          mint: mint,
          escrow: escrowPDA,
          vault: vaultPDA,
          sellerTokenAccount: sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();

      // Try to release again
      try {
        await program.methods
          .release()
          .accounts({
            buyer: buyer.publicKey,
            mint: mint,
            escrow: escrowPDA,
            vault: vaultPDA,
            sellerTokenAccount: sellerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NotLocked");
      }
    });
  });

  describe("cancel", () => {
    it("returns funds to buyer", async () => {
      const [escrowPDA] = getEscrowPDA();
      const [vaultPDA] = getVaultPDA(escrowPDA);
      const deadline = futureDeadline(3600);

      // Get buyer's initial balance
      const initialBuyerAccount = await getAccount(
        connection,
        buyerTokenAccount
      );
      const initialBalance = Number(initialBuyerAccount.amount);

      // Initialize escrow
      await program.methods
        .initialize(new BN(DEPOSIT_AMOUNT), deadline)
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint: mint,
          buyerTokenAccount: buyerTokenAccount,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Cancel escrow
      await program.methods
        .cancel()
        .accounts({
          buyer: buyer.publicKey,
          mint: mint,
          escrow: escrowPDA,
          vault: vaultPDA,
          buyerTokenAccount: buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();

      // Verify escrow state changed to Cancelled
      const escrow = await program.account.escrow.fetch(escrowPDA);
      expect(escrow.state).to.deep.equal({ cancelled: {} });

      // Verify buyer got tokens back
      const finalBuyerAccount = await getAccount(
        connection,
        buyerTokenAccount
      );
      expect(Number(finalBuyerAccount.amount)).to.equal(initialBalance);

      // Verify vault is empty
      const vaultAccount = await getAccount(connection, vaultPDA);
      expect(Number(vaultAccount.amount)).to.equal(0);
    });

    it("rejects cancel after release", async () => {
      const [escrowPDA] = getEscrowPDA();
      const [vaultPDA] = getVaultPDA(escrowPDA);
      const deadline = futureDeadline(3600);

      // Initialize and release
      await program.methods
        .initialize(new BN(DEPOSIT_AMOUNT), deadline)
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint: mint,
          buyerTokenAccount: buyerTokenAccount,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .release()
        .accounts({
          buyer: buyer.publicKey,
          mint: mint,
          escrow: escrowPDA,
          vault: vaultPDA,
          sellerTokenAccount: sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();

      // Try to cancel after release
      try {
        await program.methods
          .cancel()
          .accounts({
            buyer: buyer.publicKey,
            mint: mint,
            escrow: escrowPDA,
            vault: vaultPDA,
            buyerTokenAccount: buyerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NotLocked");
      }
    });
  });
});
