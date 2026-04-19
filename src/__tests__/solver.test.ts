import { describe, it, expect } from 'vitest';
import { solveEquations } from '../../client/bots/solver';
import { evaluateEquation } from '../equation';
import type { Card } from '../types';

describe('solveEquations', () => {
  it('finds valid low and high expressions for a typical hand', () => {
    const cards: Card[] = [
      { kind: 'number', value: 5, suit: 'Gold' },
      { kind: 'number', value: 3, suit: 'Silver' },
      { kind: 'number', value: 7, suit: 'Bronze' },
      { kind: 'number', value: 2, suit: 'Black' },
      { kind: 'operator', operator: '+' },
      { kind: 'operator', operator: '-' },
      { kind: 'operator', operator: '÷' },
    ];
    const { lowExpr, highExpr } = solveEquations(cards);
    const low  = evaluateEquation(lowExpr,  cards);
    const high = evaluateEquation(highExpr, cards);
    expect(low.ok).toBe(true);
    expect(high.ok).toBe(true);
    if (low.ok)  expect(Math.abs(low.value  -  1)).toBeLessThan(10);
    if (high.ok) expect(Math.abs(high.value - 20)).toBeLessThan(20);
  });

  it('handles a hand with a √ operator', () => {
    const cards: Card[] = [
      { kind: 'number', value: 9,  suit: 'Gold' },
      { kind: 'number', value: 4,  suit: 'Silver' },
      { kind: 'number', value: 1,  suit: 'Bronze' },
      { kind: 'number', value: 2,  suit: 'Black' },
      { kind: 'operator', operator: '√' },
      { kind: 'operator', operator: '+' },
      { kind: 'operator', operator: '-' },
      { kind: 'operator', operator: '÷' },
    ];
    const { lowExpr, highExpr } = solveEquations(cards);
    expect(evaluateEquation(lowExpr,  cards).ok).toBe(true);
    expect(evaluateEquation(highExpr, cards).ok).toBe(true);
  });
});
