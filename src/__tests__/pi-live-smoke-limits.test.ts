import { describe, expect, it } from 'vitest';

interface SmokeBudget {
  beginTurn(): void;
  request(model: object, options: object): void;
  submit(url: string): void;
  counts(): { requests: number; submissions: number };
}
const harness: { createSmokeBudget(): SmokeBudget } = await import(
  new URL('../../scripts/pi-provider-live-smoke.mjs', import.meta.url).href
);
const model = { provider: 'openai-codex', id: 'gpt-6.1-sol', api: 'openai-codex-responses' };
const options = {
  maxRetries: 0, transport: 'sse', reasoning: 'high', timeoutMs: 120_000,
  signal: new AbortController().signal,
};
const endpoint = 'https://chatgpt.com/backend-api/codex/responses';

describe('Pi live smoke request limits', () => {
  it('permits exactly one request per turn and two in total', () => {
    const budget = harness.createSmokeBudget();
    for (let turn = 0; turn < 2; turn += 1) {
      budget.beginTurn();
      budget.request(model, options);
      budget.submit(endpoint);
      expect(() => budget.request(model, options)).toThrow();
      expect(() => budget.submit(endpoint)).toThrow();
    }
    expect(() => budget.beginTurn()).toThrow();
    expect(budget.counts()).toEqual({ requests: 2, submissions: 2 });
  });

  it.each([
    { maxRetries: 1 }, { transport: 'auto' }, { reasoning: 'low' },
    { timeoutMs: 120_001 }, { signal: undefined },
    { signal: AbortSignal.abort() },
  ])('rejects unsafe request settings before submission: %j', (override) => {
    const budget = harness.createSmokeBudget();
    budget.beginTurn();
    expect(() => budget.request(model, { ...options, ...override })).toThrow();
    expect(budget.counts()).toEqual({ requests: 0, submissions: 0 });
  });

  it('rejects a fallback model and a different inference endpoint', () => {
    const budget = harness.createSmokeBudget();
    budget.beginTurn();
    expect(() => budget.request({ ...model, id: 'different-model' }, options)).toThrow();
    budget.request(model, options);
    expect(() => budget.submit('https://example.com/codex/responses')).toThrow();
    expect(budget.counts().submissions).toBe(0);
  });
});
