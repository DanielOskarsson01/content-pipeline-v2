import { describe, it, expect } from 'vitest';
import { isStepExpandable } from './StepContainer.tsx';

// Root-cause guard for the U2 summary regression: the step-10 (Review) tuning
// summary mounts only inside an EXPANDED StepContainer. If 'skipped' is ever
// dropped from the expandable set again, a skipped Review step (every
// auto-executed run) becomes unclickable and the summary is unreachable.
describe('isStepExpandable', () => {
  it('skipped steps are expandable (U2 summary + Reopen live in a skipped body)', () => {
    expect(isStepExpandable('skipped')).toBe(true);
  });

  it('active / completed / approved steps are expandable', () => {
    expect(isStepExpandable('active')).toBe(true);
    expect(isStepExpandable('completed')).toBe(true);
    expect(isStepExpandable('approved')).toBe(true);
  });

  it('pending steps stay closed — nothing to show yet', () => {
    expect(isStepExpandable('pending')).toBe(false);
  });
});
