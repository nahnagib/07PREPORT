import { describe, expect, it } from 'vitest';
import { TargetStatus, classifyVsTarget, variancePct } from '../classify';

describe('classifyVsTarget', () => {
  it('actual equals target is green', () => {
    expect(classifyVsTarget(100, 100)).toBe(TargetStatus.GREEN);
  });

  it('actual exceeds target is green', () => {
    expect(classifyVsTarget(150, 100)).toBe(TargetStatus.GREEN);
  });

  it('actual just above yellow floor is yellow', () => {
    // 91 is 9% below 100 -> yellow
    expect(classifyVsTarget(91, 100)).toBe(TargetStatus.YELLOW);
  });

  it('exactly 10 percent below target is yellow, not red', () => {
    // The exact boundary case: "within 10% below" / "up to 10%" is read as inclusive of exactly
    // 10%, so this must be YELLOW.
    expect(classifyVsTarget(90, 100)).toBe(TargetStatus.YELLOW);
  });

  it('just over 10 percent below target is red', () => {
    expect(classifyVsTarget(89.99, 100)).toBe(TargetStatus.RED);
  });

  it('far below target is red', () => {
    expect(classifyVsTarget(10, 100)).toBe(TargetStatus.RED);
  });

  it('zero actual is red when target positive', () => {
    expect(classifyVsTarget(0, 100)).toBe(TargetStatus.RED);
  });

  it('boundary holds at a different scale', () => {
    expect(classifyVsTarget(4500, 5000)).toBe(TargetStatus.YELLOW); // exactly -10%
    expect(classifyVsTarget(4499, 5000)).toBe(TargetStatus.RED);
    expect(classifyVsTarget(4501, 5000)).toBe(TargetStatus.YELLOW);
  });

  it('target null/undefined is no_target', () => {
    expect(classifyVsTarget(100, null)).toBe(TargetStatus.NO_TARGET);
    expect(classifyVsTarget(100, undefined)).toBe(TargetStatus.NO_TARGET);
  });

  it('target zero is no_target', () => {
    expect(classifyVsTarget(100, 0)).toBe(TargetStatus.NO_TARGET);
  });

  it('target negative is no_target', () => {
    expect(classifyVsTarget(100, -50)).toBe(TargetStatus.NO_TARGET);
  });

  it('actual null/undefined is no_target', () => {
    expect(classifyVsTarget(null, 100)).toBe(TargetStatus.NO_TARGET);
    expect(classifyVsTarget(undefined, 100)).toBe(TargetStatus.NO_TARGET);
  });

  it('negative actual below target is red', () => {
    expect(classifyVsTarget(-10, 100)).toBe(TargetStatus.RED);
  });
});

describe('variancePct', () => {
  it('matches target is zero variance', () => {
    expect(variancePct(100, 100)).toBe(0);
  });

  it('exactly 10 percent below', () => {
    expect(variancePct(90, 100)).toBeCloseTo(-0.1, 10);
  });

  it('above target is positive', () => {
    expect(variancePct(120, 100)).toBeCloseTo(0.2, 10);
  });

  it('missing target is null', () => {
    expect(variancePct(100, null)).toBeNull();
    expect(variancePct(100, 0)).toBeNull();
  });

  it('missing actual is null', () => {
    expect(variancePct(null, 100)).toBeNull();
  });
});
