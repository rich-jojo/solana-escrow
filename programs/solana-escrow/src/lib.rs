use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("HgCVVxrJ3sV6Z2a7B37jz98u9rSuquEcfNnTj26YvdM2");

/// Maximum escrow duration: 90 days in seconds.
const MAX_DEADLINE_SECS: i64 = 90 * 24 * 60 * 60;

#[program]
pub mod solana_escrow {
    use super::*;

    /// Initialize an escrow: buyer deposits `amount` SPL tokens into a PDA vault.
    /// The seller can receive funds only when the buyer calls `release`.
    /// The buyer can cancel (reclaim funds) at any time before release.
    /// If the deadline passes without release, the escrow is still cancellable.
    pub fn initialize(
        ctx: Context<Initialize>,
        amount: u64,
        deadline: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        require!(deadline > now, EscrowError::DeadlineInPast);
        require!(
            deadline <= now + MAX_DEADLINE_SECS,
            EscrowError::DeadlineTooFar
        );

        // Populate escrow state
        let escrow = &mut ctx.accounts.escrow;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = ctx.accounts.seller.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.amount = amount;
        escrow.deadline = deadline;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;
        escrow.state = EscrowState::Locked;

        // Transfer tokens from buyer's ATA → vault
        let decimals = ctx.accounts.mint.decimals;
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.buyer_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.buyer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token_interface::transfer_checked(cpi_ctx, amount, decimals)?;

        msg!(
            "Escrow initialized: {} tokens locked until {}",
            amount,
            deadline
        );
        Ok(())
    }

    /// Release: buyer approves delivery and funds are sent to the seller.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Locked, EscrowError::NotLocked);

        let amount = escrow.amount;
        let decimals = ctx.accounts.mint.decimals;
        let escrow_key = escrow.key();

        // PDA signer seeds for the vault
        let seeds = &[
            b"vault".as_ref(),
            escrow_key.as_ref(),
            &[escrow.vault_bump],
        ];
        let signer = &[&seeds[..]];

        // Transfer tokens from vault → seller's ATA
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.seller_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token_interface::transfer_checked(cpi_ctx, amount, decimals)?;

        // Update state
        let escrow = &mut ctx.accounts.escrow;
        escrow.state = EscrowState::Released;

        msg!("Escrow released: {} tokens sent to seller", amount);
        Ok(())
    }

    /// Cancel: buyer reclaims funds. The buyer can cancel at any time
    /// while the escrow is still locked (before release).
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Locked, EscrowError::NotLocked);

        let amount = escrow.amount;
        let decimals = ctx.accounts.mint.decimals;
        let escrow_key = escrow.key();

        // PDA signer seeds for the vault
        let seeds = &[
            b"vault".as_ref(),
            escrow_key.as_ref(),
            &[escrow.vault_bump],
        ];
        let signer = &[&seeds[..]];

        // Transfer tokens from vault → buyer's ATA
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.buyer_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token_interface::transfer_checked(cpi_ctx, amount, decimals)?;

        // Update state
        let escrow = &mut ctx.accounts.escrow;
        escrow.state = EscrowState::Cancelled;

        msg!("Escrow cancelled: {} tokens returned to buyer", amount);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    /// The buyer who deposited tokens.
    pub buyer: Pubkey,
    /// The seller who will receive tokens on release.
    pub seller: Pubkey,
    /// SPL token mint.
    pub mint: Pubkey,
    /// Amount of tokens locked.
    pub amount: u64,
    /// Unix timestamp after which the buyer can cancel.
    pub deadline: i64,
    /// PDA bump for the escrow account.
    pub bump: u8,
    /// PDA bump for the vault token account.
    pub vault_bump: u8,
    /// Current escrow state.
    pub state: EscrowState,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowState {
    Locked,
    Released,
    Cancelled,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Buyer creating the escrow; pays for account creation and deposits tokens.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// Seller's public key (does not need to sign).
    /// CHECK: We only store the seller's pubkey; no data is read from this account.
    pub seller: UncheckedAccount<'info>,

    /// SPL token mint for the escrowed asset.
    pub mint: InterfaceAccount<'info, Mint>,

    /// Buyer's token account (source of deposited tokens).
    #[account(
        mut,
        token::mint = mint,
        token::authority = buyer,
    )]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Escrow state PDA. Seeds: ["escrow", buyer, seller, mint].
    #[account(
        init,
        payer = buyer,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", buyer.key().as_ref(), seller.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    /// Vault token account PDA that holds the escrowed tokens.
    /// Authority is itself (the vault PDA) so only the program can move funds.
    #[account(
        init,
        payer = buyer,
        token::mint = mint,
        token::authority = vault,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    /// Only the buyer can release funds.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// SPL token mint (needed for transfer_checked).
    pub mint: InterfaceAccount<'info, Mint>,

    /// Escrow state — must be locked and belong to this buyer.
    #[account(
        mut,
        seeds = [b"escrow", buyer.key().as_ref(), escrow.seller.as_ref(), escrow.mint.as_ref()],
        bump = escrow.bump,
        has_one = buyer,
        has_one = mint,
    )]
    pub escrow: Account<'info, Escrow>,

    /// Vault holding the tokens.
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Seller's token account to receive funds.
    #[account(
        mut,
        token::mint = mint,
    )]
    pub seller_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    /// Only the buyer can cancel.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// SPL token mint (needed for transfer_checked).
    pub mint: InterfaceAccount<'info, Mint>,

    /// Escrow state — must be locked and belong to this buyer.
    #[account(
        mut,
        seeds = [b"escrow", buyer.key().as_ref(), escrow.seller.as_ref(), escrow.mint.as_ref()],
        bump = escrow.bump,
        has_one = buyer,
        has_one = mint,
    )]
    pub escrow: Account<'info, Escrow>,

    /// Vault holding the tokens.
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Buyer's token account to receive refund.
    #[account(
        mut,
        token::mint = mint,
        token::authority = buyer,
    )]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum EscrowError {
    #[msg("Escrow amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deadline must be in the future")]
    DeadlineInPast,
    #[msg("Deadline exceeds maximum allowed duration (90 days)")]
    DeadlineTooFar,
    #[msg("Escrow is not in Locked state")]
    NotLocked,
}
