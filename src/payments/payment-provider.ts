/**
 * Payment provider abstraction. Only a SIMULATED provider ships with Tinbit.
 * Real-money providers (e.g. a licensed Ethiopian mobile-money or bank gateway) must
 * implement this interface AND pass legal/regulatory approval + an independent
 * security and financial review before being enabled. No real credentials exist here.
 */
export interface ProviderDepositInit {
  intentId: string;
  amount: string;
  userId: string;
}

export interface ProviderWebhookEvent {
  externalRef: string;
  intentId: string;
  status: 'COMPLETED' | 'FAILED' | 'REFUNDED';
  amount: string;
  failureReason?: string;
}

export interface PaymentProvider {
  readonly name: string;
  readonly realMoney: boolean;
  /** Start a deposit. Returns a provider reference (and e.g. a checkout URL for real providers). */
  initiateDeposit(init: ProviderDepositInit): Promise<{ externalRef: string; checkoutUrl?: string }>;
  /** Send an approved withdrawal to the user's payout destination. */
  sendPayout(init: ProviderDepositInit): Promise<{ externalRef: string }>;
  /** Verify a webhook's authenticity (HMAC signature etc.) and parse it. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): ProviderWebhookEvent;
}

export class SimulatedPaymentProvider implements PaymentProvider {
  readonly name = 'simulated';
  readonly realMoney = false;
  async initiateDeposit(init: ProviderDepositInit) {
    return { externalRef: `sim_dep_${init.intentId}` };
  }
  async sendPayout(init: ProviderDepositInit) {
    return { externalRef: `sim_pay_${init.intentId}` };
  }
  verifyWebhook(): ProviderWebhookEvent {
    throw new Error('The simulated provider does not receive external webhooks');
  }
}

export class DisabledPaymentProvider implements PaymentProvider {
  readonly name = 'disabled';
  readonly realMoney = false;
  async initiateDeposit(): Promise<never> {
    throw new Error('Payments are disabled');
  }
  async sendPayout(): Promise<never> {
    throw new Error('Payments are disabled');
  }
  verifyWebhook(): never {
    throw new Error('Payments are disabled');
  }
}

/** Simple, explainable fraud/risk rules. Replace with a real screening service later. */
export function screenPayment(kind: 'DEPOSIT' | 'WITHDRAWAL', amount: number, ctx: { accountAgeHours: number; recentCount: number }) {
  const flags: string[] = [];
  if (amount >= 50_000) flags.push('LARGE_AMOUNT');
  if (ctx.accountAgeHours < 24 && kind === 'WITHDRAWAL') flags.push('NEW_ACCOUNT_WITHDRAWAL');
  if (ctx.recentCount >= 5) flags.push('HIGH_VELOCITY');
  return flags;
}
