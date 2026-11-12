-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'RESOLVER', 'REVIEWER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('USER_AVAILABLE', 'USER_RESERVED', 'MARKET_ESCROW', 'COMPANY_RESERVE', 'FEE_REVENUE', 'PROMOTIONS', 'EQUITY', 'PAYMENT_CLEARING', 'ADJUSTMENTS');

-- CreateEnum
CREATE TYPE "EntryKind" AS ENUM ('GENESIS', 'SIGNUP_BONUS', 'DEPOSIT', 'WITHDRAWAL_HOLD', 'WITHDRAWAL_RELEASE', 'WITHDRAWAL_PAYOUT', 'TRADE_BUY', 'TRADE_SELL', 'LIQUIDITY_FUNDING', 'LIQUIDITY_RETURN', 'SETTLEMENT_PAYOUT', 'CANCELLATION_REFUND', 'ADMIN_ADJUSTMENT', 'RESERVE_TOPUP');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'AWAITING_RESOLUTION', 'DISPUTED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('ETHIOPIAN_FOOTBALL', 'PREMIER_LEAGUE', 'CHAMPIONS_LEAGUE', 'INTERNATIONAL_FOOTBALL', 'MUSIC', 'TELEVISION', 'ENTERTAINMENT', 'CULTURE', 'OTHER');

-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('BINARY', 'FOOTBALL_HOME_WIN', 'FOOTBALL_AWAY_WIN', 'FOOTBALL_OVER_2_5', 'FOOTBALL_BTTS');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('YES', 'NO');

-- CreateEnum
CREATE TYPE "FinalOutcome" AS ENUM ('YES', 'NO', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CancellationPolicy" AS ENUM ('REFUND_NET_COST', 'LAST_PRICE');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "ProposalSource" AS ENUM ('MANUAL', 'AUTOMATED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING_REVIEW', 'REJECTED', 'CONFIRMED', 'DISPUTED', 'OVERTURNED', 'FINALIZED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UPHELD', 'REJECTED');

-- CreateEnum
CREATE TYPE "FixtureStatus" AS ENUM ('SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('DEPOSIT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'REQUIRES_APPROVAL', 'COMPLETED', 'FAILED', 'REJECTED', 'REFUNDED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "roles" "Role"[] DEFAULT ARRAY['USER']::"Role"[],
    "locale" TEXT NOT NULL DEFAULT 'en',
    "country" TEXT NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "twoFactorVerified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "userId" TEXT,
    "marketId" TEXT,
    "balance" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "kind" "EntryKind" NOT NULL,
    "memo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "marketId" TEXT,
    "referenceId" TEXT,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "balanceAfter" DECIMAL(20,2) NOT NULL,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "questionAm" TEXT,
    "description" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "type" "MarketType" NOT NULL DEFAULT 'BINARY',
    "yesLabel" TEXT NOT NULL DEFAULT 'Yes',
    "noLabel" TEXT NOT NULL DEFAULT 'No',
    "imageEmoji" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "resolvesAt" TIMESTAMP(3) NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'DRAFT',
    "tradingHalted" BOOLEAN NOT NULL DEFAULT false,
    "haltReason" TEXT,
    "initialProbability" DECIMAL(8,6) NOT NULL,
    "liquidityB" DECIMAL(20,6) NOT NULL,
    "feeBps" INTEGER NOT NULL DEFAULT 100,
    "subsidy" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "riskBudget" DECIMAL(20,2) NOT NULL,
    "maxTradeAmount" DECIMAL(20,2) NOT NULL DEFAULT 50000,
    "liquidityFundedAt" TIMESTAMP(3),
    "yesShares" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "noShares" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "volume" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "tradesCount" INTEGER NOT NULL DEFAULT 0,
    "lastYesPrice" DECIMAL(10,8) NOT NULL,
    "closingYesPrice" DECIMAL(10,8),
    "resolutionRules" TEXT NOT NULL,
    "sourcePrimary" TEXT NOT NULL,
    "sourceBackup" TEXT,
    "cancellationRules" TEXT NOT NULL,
    "cancellationPolicy" "CancellationPolicy" NOT NULL DEFAULT 'REFUND_NET_COST',
    "disputeHours" INTEGER NOT NULL DEFAULT 24,
    "resolvedOutcome" "FinalOutcome",
    "resolvedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "fixtureId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricePoint" (
    "id" BIGSERIAL NOT NULL,
    "marketId" TEXT NOT NULL,
    "yesPrice" DECIMAL(10,8) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricePoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "outcome" "Outcome" NOT NULL,
    "shares" DECIMAL(24,6) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "fee" DECIMAL(20,2) NOT NULL,
    "avgPrice" DECIMAL(10,8) NOT NULL,
    "yesPriceBefore" DECIMAL(10,8) NOT NULL,
    "yesPriceAfter" DECIMAL(10,8) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "yesShares" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "noShares" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "yesCost" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "noCost" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "netContributed" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "settledPayout" DECIMAL(20,2),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionProposal" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcome" "FinalOutcome" NOT NULL,
    "source" "ProposalSource" NOT NULL,
    "evidenceUrl" TEXT NOT NULL,
    "evidenceNotes" TEXT NOT NULL,
    "proposedById" TEXT,
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "disputeEndsAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "ResolutionProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceUrl" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcome" "FinalOutcome" NOT NULL,
    "totalPayout" DECIMAL(20,2) NOT NULL,
    "returnedToReserve" DECIMAL(20,2) NOT NULL,
    "positions" INTEGER NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fixture" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "kickoffAt" TIMESTAMP(3) NOT NULL,
    "status" "FixtureStatus" NOT NULL DEFAULT 'SCHEDULED',
    "homeGoals" INTEGER,
    "awayGoals" INTEGER,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "Fixture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "externalRef" TEXT,
    "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "idempotencyKey" TEXT NOT NULL,
    "reviewedById" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "cash" DECIMAL(20,2) NOT NULL,
    "value" DECIMAL(20,2) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "reason" TEXT,
    "data" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_type_userId_marketId_key" ON "Account"("type", "userId", "marketId");

-- CreateIndex
CREATE INDEX "JournalEntry_marketId_idx" ON "JournalEntry"("marketId");

-- CreateIndex
CREATE INDEX "JournalEntry_referenceId_idx" ON "JournalEntry"("referenceId");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "Market_slug_key" ON "Market"("slug");

-- CreateIndex
CREATE INDEX "Market_status_closesAt_idx" ON "Market"("status", "closesAt");

-- CreateIndex
CREATE INDEX "Market_category_idx" ON "Market"("category");

-- CreateIndex
CREATE INDEX "PricePoint_marketId_at_idx" ON "PricePoint"("marketId", "at");

-- CreateIndex
CREATE INDEX "Trade_marketId_createdAt_idx" ON "Trade"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_userId_createdAt_idx" ON "Trade"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_userId_idempotencyKey_key" ON "Trade"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Position_marketId_idx" ON "Position"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_userId_marketId_key" ON "Position"("userId", "marketId");

-- CreateIndex
CREATE INDEX "ResolutionProposal_marketId_idx" ON "ResolutionProposal"("marketId");

-- CreateIndex
CREATE INDEX "ResolutionProposal_status_idx" ON "ResolutionProposal"("status");

-- CreateIndex
CREATE INDEX "Dispute_proposalId_idx" ON "Dispute"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_marketId_key" ON "Settlement"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "Fixture_provider_externalId_key" ON "Fixture"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_externalRef_key" ON "PaymentIntent"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_userId_idempotencyKey_key" ON "PaymentIntent"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_userId_at_idx" ON "PortfolioSnapshot"("userId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricePoint" ADD CONSTRAINT "PricePoint_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionProposal" ADD CONSTRAINT "ResolutionProposal_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ResolutionProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ════════════════════ Financial integrity constraints (hand-written) ════════════════════

-- Customer & escrow accounts can never go negative.
ALTER TABLE "Account" ADD CONSTRAINT "account_non_negative" CHECK ("allowNegative" OR "balance" >= 0);

-- Positions & outstanding shares can never go negative.
ALTER TABLE "Position" ADD CONSTRAINT "position_non_negative"
  CHECK ("yesShares" >= 0 AND "noShares" >= 0 AND "yesCost" >= 0 AND "noCost" >= 0);
ALTER TABLE "Market" ADD CONSTRAINT "market_shares_non_negative" CHECK ("yesShares" >= 0 AND "noShares" >= 0);
ALTER TABLE "Market" ADD CONSTRAINT "market_prob_bounds" CHECK ("initialProbability" >= 0.01 AND "initialProbability" <= 0.99);
ALTER TABLE "Market" ADD CONSTRAINT "market_b_positive" CHECK ("liquidityB" > 0);
ALTER TABLE "Market" ADD CONSTRAINT "market_price_bounds" CHECK ("lastYesPrice" > 0 AND "lastYesPrice" < 1);
ALTER TABLE "Market" ADD CONSTRAINT "market_fee_bounds" CHECK ("feeBps" >= 0 AND "feeBps" <= 1000);
ALTER TABLE "Market" ADD CONSTRAINT "market_dates" CHECK ("opensAt" < "closesAt" AND "closesAt" <= "resolvesAt");
ALTER TABLE "Trade" ADD CONSTRAINT "trade_positive" CHECK ("shares" > 0 AND "amount" >= 0 AND "fee" >= 0);
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "payment_positive" CHECK ("amount" > 0);

-- Account uniqueness with NULLs (Postgres treats NULLs as distinct in normal unique indexes).
CREATE UNIQUE INDEX "account_unique_owner" ON "Account" ("type", COALESCE("userId", ''), COALESCE("marketId", ''));

-- Every journal entry must balance to exactly zero (checked at commit time).
CREATE OR REPLACE FUNCTION check_journal_balanced() RETURNS trigger AS $$
DECLARE s numeric;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO s FROM "JournalLine" WHERE "entryId" = NEW."entryId";
  IF s <> 0 THEN
    RAISE EXCEPTION 'journal entry % does not balance (sum=%)', NEW."entryId", s;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_balanced
  AFTER INSERT OR UPDATE ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_balanced();

-- Ledger and audit log are append-only.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_line_append_only BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_entry_append_only BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
