// Run: `npm test` (client) or `npx vitest run`.
import { describe, it, expect } from 'vitest';
import { computeOverrides } from './workbenchOverrides.ts';

describe('computeOverrides', () => {
  it('returns only keys that differ from the baseline', () => {
    expect(computeOverrides({ model: 'haiku', max_tokens: 4000 }, { model: 'sonnet', max_tokens: 4000 }))
      .toEqual({ model: 'sonnet' });
  });
  it('is empty when nothing was edited', () => {
    expect(computeOverrides({ a: 1 }, { a: 1 })).toEqual({});
  });
  it('deep-compares objects and arrays', () => {
    expect(computeOverrides({ tags: ['a'] }, { tags: ['a'] })).toEqual({});
    expect(computeOverrides({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual({ tags: ['a', 'b'] });
  });
  it('includes keys absent from the baseline', () => {
    expect(computeOverrides({}, { temperature: 0.3 })).toEqual({ temperature: 0.3 });
  });
});
