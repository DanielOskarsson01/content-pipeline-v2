import { describe, it, expect } from 'vitest';
import { nextStepReads, downstreamToErase, promotableExperimentId } from './tuningSession.ts';
import type { TuningSessionStep } from '../types/step';

const step = (step_index: number, submodule_id = `mod-${step_index}`): TuningSessionStep => ({
  session_id: 's1', step_index, submodule_id, experiment_id: `e${step_index}`,
});

describe('nextStepReads', () => {
  it('reads the pool when nothing is accepted upstream', () => {
    expect(nextStepReads([], 6)).toEqual({ source: 'pool', from: null });
    // an accepted step AT or ABOVE the current step is not upstream
    expect(nextStepReads([step(6), step(7)], 6)).toEqual({ source: 'pool', from: null });
  });

  it('chains from the nearest accepted step below the current step', () => {
    const steps = [step(2), step(5)];
    const r = nextStepReads(steps, 6);
    expect(r.source).toBe('chained');
    expect(r.from?.step_index).toBe(5); // nearest-below, not the earliest
  });

  it('is order-independent (server returns asc but do not assume it)', () => {
    const r = nextStepReads([step(5), step(2)], 6);
    expect(r.from?.step_index).toBe(5);
  });
});

describe('downstreamToErase', () => {
  it('returns nothing when re-accepting at the last accepted step', () => {
    expect(downstreamToErase([step(5), step(6)], 6)).toEqual([]);
  });

  it('returns every accepted step strictly downstream, ascending', () => {
    const erased = downstreamToErase([step(5), step(6), step(8), step(7)], 5);
    expect(erased.map((s) => s.step_index)).toEqual([6, 7, 8]);
  });

  it('excludes the step being re-accepted itself', () => {
    const erased = downstreamToErase([step(5), step(6)], 5);
    expect(erased.map((s) => s.step_index)).toEqual([6]);
  });
});

describe('promotableExperimentId', () => {
  it('returns the accepted experiment id for the step (independent of any live result)', () => {
    expect(promotableExperimentId([step(4), step(5)], 5)).toBe('e5');
  });

  it('returns null when the step has nothing accepted — promote must not offer', () => {
    expect(promotableExperimentId([step(4)], 5)).toBeNull();
    expect(promotableExperimentId([], 5)).toBeNull();
  });
});
