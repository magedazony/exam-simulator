// Store purchase verification. The API depends on this interface only.
//
// Google Play is implemented in billing-google.ts and is switched on by
// server settings. Apple is not implemented: an iOS app does not exist yet.
// A platform that is not configured refuses purchases with a clear error
// rather than trusting the client.

export interface VerifiedPurchase {
  /** The store's own transaction id; one entitlement per transaction. */
  transactionId: string;
  productId: string;
}

export interface StoreVerifier {
  /** Resolves to null when the store says the purchase is not valid. */
  verify(platform: 'apple' | 'google', productId: string, purchaseToken: string): Promise<VerifiedPurchase | null>;
  /**
   * Called after the pass has been granted: tells the store the purchase was
   * delivered (Google refunds purchases not acknowledged within three days)
   * and consumes it so the same pass can be bought again later.
   */
  complete?(platform: 'apple' | 'google', productId: string, purchaseToken: string): Promise<void>;
}

export class BillingNotConfiguredError extends Error {
  constructor() {
    super('store billing is not configured');
    this.name = 'BillingNotConfiguredError';
  }
}

export const notConfiguredVerifier: StoreVerifier = {
  async verify() {
    throw new BillingNotConfiguredError();
  },
};

/** Routes each platform to its verifier; platforms without one are refused. */
export function verifierFor(byPlatform: Partial<Record<'apple' | 'google', StoreVerifier>>): StoreVerifier {
  const pick = (p: 'apple' | 'google') => byPlatform[p] ?? notConfiguredVerifier;
  return {
    verify: (p, id, token) => pick(p).verify(p, id, token),
    complete: async (p, id, token) => { await pick(p).complete?.(p, id, token); },
  };
}
