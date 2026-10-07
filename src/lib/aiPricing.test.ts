import { describe, it, expect } from 'vitest';
import { estimateCostUsd } from '../../api/_lib/aiPricing';

describe('estimateCostUsd', () => {
  it('returns null for an unknown model rather than guessing a rate', () => {
    const result = estimateCostUsd({
      model: 'claude-made-up-model',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      webSearchRequests: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when input or output tokens are missing -- never substitutes 0', () => {
    expect(estimateCostUsd({
      model: 'claude-sonnet-5',
      inputTokens: null,
      outputTokens: 50,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      webSearchRequests: null,
    })).toBeNull();
    expect(estimateCostUsd({
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      webSearchRequests: null,
    })).toBeNull();
  });

  it('computes a plain input+output estimate for claude-sonnet-5 with no caching/search', () => {
    const result = estimateCostUsd({
      model: 'claude-sonnet-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      webSearchRequests: null,
    });
    // $2/MTok input + $10/MTok output at exactly 1M tokens each.
    expect(result).toBeCloseTo(12, 6);
  });

  it('prices cache_read_input_tokens at the cheaper cache-read rate, not the base input rate', () => {
    const result = estimateCostUsd({
      model: 'claude-sonnet-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 1_000_000,
      webSearchRequests: null,
    });
    // $0.20/MTok cache-read rate for Sonnet 5, not $2/MTok.
    expect(result).toBeCloseTo(0.2, 6);
  });

  it('adds a flat $0.01/search web-search fee on top of token costs', () => {
    const withoutSearch = estimateCostUsd({
      model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 1000,
      cacheCreationInputTokens: null, cacheReadInputTokens: null, webSearchRequests: null,
    })!;
    const withSearch = estimateCostUsd({
      model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 1000,
      cacheCreationInputTokens: null, cacheReadInputTokens: null, webSearchRequests: 3,
    })!;
    expect(withSearch - withoutSearch).toBeCloseTo(0.03, 6);
  });

  it('uses the cheaper claude-haiku-4-5-20251001 rates for the vision surface', () => {
    const result = estimateCostUsd({
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      webSearchRequests: null,
    });
    // $1/MTok input + $5/MTok output.
    expect(result).toBeCloseTo(6, 6);
  });
});
