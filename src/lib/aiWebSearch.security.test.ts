import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo, e.g. aiServiceSearch.security.test.ts) for the web_search
// server-side tool wired into api/ai-assistant.ts + api/_lib/aiTools.ts.

let assistantSrc: string;
let toolsSrc: string;

beforeAll(() => {
  const apiDir = join(__dirname, '..', '..', 'api');
  assistantSrc = readFileSync(join(apiDir, 'ai-assistant.ts'), 'utf8');
  toolsSrc = readFileSync(join(apiDir, '_lib', 'aiTools.ts'), 'utf8');
});

describe('web_search tool definition', () => {
  it('is present in aiTools.ts with the correct server-side tool type and name', () => {
    expect(toolsSrc).toMatch(/type:\s*'web_search_20260209'/);
    expect(toolsSrc).toMatch(/name:\s*WEB_SEARCH_TOOL_NAME/);
    expect(toolsSrc).toMatch(/WEB_SEARCH_TOOL_NAME\s*=\s*'web_search'/);
  });

  it('bounds max_uses per turn to a small, explicit number', () => {
    const match = toolsSrc.match(/WEB_SEARCH_MAX_USES\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    const maxUses = Number(match?.[1]);
    expect(maxUses).toBeGreaterThan(0);
    expect(maxUses).toBeLessThanOrEqual(5);
    expect(toolsSrc).toMatch(/max_uses:\s*WEB_SEARCH_MAX_USES/);
  });

  it('is added to the tools array sent to the Anthropic Messages API', () => {
    expect(assistantSrc).toMatch(/tools:\s*\[\.\.\.ALL_TOOLS,\s*WEB_SEARCH_TOOL\]/);
  });
});

describe('web_search tool_use blocks are never routed through the manual VENTS-tool dispatcher', () => {
  it('excludes WEB_SEARCH_TOOL_NAME before building the manually-dispatched toolUseBlocks list', () => {
    const filterLine = assistantSrc.match(/const toolUseBlocks = blocks\.filter\(.*\);/)?.[0] ?? '';
    expect(filterLine).toMatch(/WEB_SEARCH_TOOL_NAME/);
    expect(filterLine).toMatch(/!==/);
  });

  it('the manual dispatch loop (executeReadOnlyTool / proposal check) only ever sees toolUseBlocks, not raw blocks', () => {
    expect(assistantSrc).toMatch(/toolUseBlocks\.find\(\(b\) => PROPOSAL_TOOL_NAMES\.has\(b\.name\)\)/);
    expect(assistantSrc).toMatch(/toolUseBlocks\.map\(async \(block\) => \{/);
  });

  it('surfaces server-resolved web_search_tool_result blocks as their own external-sourced cards, not as tool_result dispatch', () => {
    expect(assistantSrc).toMatch(/b\.type === 'web_search_tool_result'/);
    expect(assistantSrc).toMatch(/source:\s*'external'/);
  });
});

describe('system prompt: source-of-truth instructions for VENTS AI', () => {
  it('instructs the model never to use its own knowledge for current external events/artists/services', () => {
    expect(assistantSrc).toMatch(/NEVER answer a question about a current external event.*web_search instead\./s);
  });

  it('instructs the model not to call web_search for general\\/stable knowledge', () => {
    expect(assistantSrc).toMatch(/do NOT call web_search for it/);
  });

  it('instructs the model to use VENTS tools, never web_search or its own knowledge, for VENTS-specific questions', () => {
    expect(assistantSrc).toMatch(/always call the matching VENTS tool.*never web_search, never your own knowledge/);
  });

  it('instructs the model to label web_search-derived content as external and never imply it is bookable on VENTS', () => {
    expect(assistantSrc).toMatch(/clearly label it as coming from outside VENTS/);
    expect(assistantSrc).toMatch(/NEVER imply that an externally-found event, artist appearance, or service\/business is bookable through VENTS/);
  });

  it('preserves the pre-existing anti-hallucination instruction against fabricating live VENTS data', () => {
    expect(assistantSrc).toMatch(/NEVER fabricate live VENTS data/);
  });
});
