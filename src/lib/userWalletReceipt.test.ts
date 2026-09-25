import { describe, it, expect } from 'vitest';
import { classifyWalletTransaction, ClassifiableWalletTransaction } from './walletTransactionClassifier';

// Regression tests for the customer wallet receipt/detail work: transaction
// classification must derive entirely from server-authoritative fields
// (type, reference_id's established prefix/shape conventions) and never
// guess a category the data doesn't support.

function tx(overrides: Partial<ClassifiableWalletTransaction>): ClassifiableWalletTransaction {
  return {
    type: 'spend',
    referenceId: null,
    ...overrides,
  };
}

describe('classifyWalletTransaction', () => {
  it('classifies a deposit by type alone', () => {
    expect(classifyWalletTransaction(tx({ type: 'deposit', referenceId: 'wdep_abc123' }))).toBe('deposit');
  });

  it('classifies a spend with a VNT- reference as a ticket purchase', () => {
    expect(classifyWalletTransaction(tx({ type: 'spend', referenceId: 'VNT-8ba0a4a41217467ab2a5017fe797082a' }))).toBe('ticket_purchase');
  });

  it('classifies a spend with a BKG- reference as a service purchase', () => {
    expect(classifyWalletTransaction(tx({ type: 'spend', referenceId: 'BKG-067b95789bc4431aa36d6a2d8efe1a3b' }))).toBe('service_purchase');
  });

  it('classifies a refund whose reference_id is a bare ticket UUID as a ticket refund', () => {
    expect(classifyWalletTransaction(tx({ type: 'refund', referenceId: 'e9d34a53-b4fe-42a8-b132-de8762c97bf0' }))).toBe('ticket_refund');
  });

  it('never fabricates a ticket_refund classification for a refund whose reference does not look like a UUID', () => {
    expect(classifyWalletTransaction(tx({ type: 'refund', referenceId: 'not-a-uuid' }))).toBe('other');
    expect(classifyWalletTransaction(tx({ type: 'refund', referenceId: null }))).toBe('other');
  });

  it('falls back to "other" for a spend with no recognized reference prefix, rather than guessing', () => {
    expect(classifyWalletTransaction(tx({ type: 'spend', referenceId: 'something-unexpected' }))).toBe('other');
    expect(classifyWalletTransaction(tx({ type: 'spend', referenceId: null }))).toBe('other');
  });

  it('a deposit is classified as deposit even if referenceId happens to look like something else (type is authoritative, not reference shape)', () => {
    expect(classifyWalletTransaction(tx({ type: 'deposit', referenceId: 'VNT-lookalike' }))).toBe('deposit');
  });
});
