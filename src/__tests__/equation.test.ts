import { describe, it, expect } from 'vitest';
import { evaluateEquation, closenessToTarget, buildCardMultiset } from '../equation';
import { Card } from '../types';

function numCard(value: number): Card {
  return { kind: 'number', value: value as 0, suit: 'Gold' };
}
function opCard(operator: '+' | '-' | '÷' | '×' | '√'): Card {
  return { kind: 'operator', operator };
}

describe('evaluateEquation', () => {
  it('evaluates simple addition', () => {
    const cards: Card[] = [numCard(3), numCard(5), opCard('+'), opCard('-'), opCard('÷')];
    // Must use all cards. Build an expression that uses 3, 5, +, -, ÷.
    // e.g. 3 + 5 - 0... we don't have a 0. Let's use: (3 + 5) ÷ (something)
    // Actually let's construct cards that exactly fit the expression.
    const cards2: Card[] = [numCard(3), numCard(5), opCard('+')];
    const result = evaluateEquation('3 + 5', cards2);
    expect(result).toEqual({ ok: true, value: 8 });
  });

  it('evaluates multiplication', () => {
    const cards: Card[] = [numCard(4), numCard(3), opCard('×')];
    const result = evaluateEquation('4 × 3', cards);
    expect(result).toEqual({ ok: true, value: 12 });
  });

  it('accepts * as ×', () => {
    const cards: Card[] = [numCard(4), numCard(3), opCard('×')];
    const result = evaluateEquation('4 * 3', cards);
    expect(result).toEqual({ ok: true, value: 12 });
  });

  it('evaluates square root', () => {
    const cards: Card[] = [numCard(9), opCard('√')];
    const result = evaluateEquation('√9', cards);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value).toBeCloseTo(3);
  });

  it('evaluates division', () => {
    const cards: Card[] = [numCard(8), numCard(2), opCard('÷')];
    const result = evaluateEquation('8 ÷ 2', cards);
    expect(result).toEqual({ ok: true, value: 4 });
  });

  it('accepts / as ÷', () => {
    const cards: Card[] = [numCard(8), numCard(2), opCard('÷')];
    const result = evaluateEquation('8 / 2', cards);
    expect(result).toEqual({ ok: true, value: 4 });
  });

  it('respects operator precedence (× before +)', () => {
    const cards: Card[] = [numCard(2), numCard(3), numCard(4), opCard('+'), opCard('×')];
    const result = evaluateEquation('2 + 3 × 4', cards);
    expect(result).toEqual({ ok: true, value: 14 }); // not 20
  });

  it('rejects parentheses — precedence alone decides the order', () => {
    const cards: Card[] = [numCard(2), numCard(3), numCard(4), opCard('+'), opCard('×')];
    // Grouping would turn 14 into 20; the rules do not allow buying that.
    const result = evaluateEquation('(2 + 3) × 4', cards);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Parentheses are not allowed/);
  });

  it('rejects a stray closing parenthesis', () => {
    const cards: Card[] = [numCard(2), numCard(3), opCard('+')];
    expect(evaluateEquation('2 + 3)', cards).ok).toBe(false);
  });

  it('produces negative results', () => {
    const cards: Card[] = [numCard(1), numCard(10), opCard('-')];
    const result = evaluateEquation('1 - 10', cards);
    expect(result).toEqual({ ok: true, value: -9 });
  });

  it('rejects division by zero', () => {
    const cards: Card[] = [numCard(5), numCard(0), opCard('÷')];
    const result = evaluateEquation('5 ÷ 0', cards);
    expect(result.ok).toBe(false);
  });

  it('applies √ to a single number, never to a sub-expression', () => {
    const cards: Card[] = [numCard(1), numCard(4), opCard('√'), opCard('-')];
    // Grouping is the only way to root an arithmetic result, and there is none,
    // so √ of a negative is unreachable rather than merely rejected.
    expect(evaluateEquation('√(1 - 4)', cards).ok).toBe(false);
    // √ binds to the number beside it: this is (√4) - 1, not √(4 - 1).
    expect(evaluateEquation('√4 - 1', cards)).toEqual({ ok: true, value: 1 });
  });

  it('rejects √ with no number after it', () => {
    const cards: Card[] = [numCard(4), numCard(2), opCard('√'), opCard('+')];
    expect(evaluateEquation('4 + 2 √', cards).ok).toBe(false);
    expect(evaluateEquation('√ + 4 2', cards).ok).toBe(false);
  });

  it('rejects mismatched number cards', () => {
    const cards: Card[] = [numCard(3), numCard(4), opCard('+')];
    const result = evaluateEquation('3 + 5', cards); // 5 not in hand
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/Numbers used/);
  });

  it('rejects mismatched operator cards', () => {
    const cards: Card[] = [numCard(3), numCard(5), opCard('+')];
    const result = evaluateEquation('3 × 5', cards); // × not in hand
    expect(result.ok).toBe(false);
  });

  it('rejects extra tokens after expression', () => {
    const cards: Card[] = [numCard(3), numCard(5), opCard('+')];
    const result = evaluateEquation('3 + 5 )', cards);
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate number not in hand', () => {
    // Hand has one 3, expression uses two 3s
    const cards: Card[] = [numCard(3), numCard(5), opCard('+')];
    const result = evaluateEquation('3 + 3', cards); // only one 3 in hand
    expect(result.ok).toBe(false);
  });

  it('accepts expression using duplicate numbers that match hand', () => {
    // Hand has two 3s
    const cards: Card[] = [numCard(3), numCard(3), opCard('+')];
    const result = evaluateEquation('3 + 3', cards);
    expect(result).toEqual({ ok: true, value: 6 });
  });

  it('rejects expression with 0 when hand has no 0', () => {
    const cards: Card[] = [numCard(1), numCard(2), opCard('+')];
    const result = evaluateEquation('0 + 2', cards);
    expect(result.ok).toBe(false);
  });

  it('evaluates expression using 0 when hand has 0', () => {
    const cards: Card[] = [numCard(0), numCard(5), opCard('+')];
    const result = evaluateEquation('0 + 5', cards);
    expect(result).toEqual({ ok: true, value: 5 });
  });

  it('rejects an opening parenthesis', () => {
    const cards: Card[] = [numCard(3), numCard(5), opCard('+')];
    expect(evaluateEquation('(3 + 5', cards).ok).toBe(false);
  });

  it('rejects empty expression', () => {
    const result = evaluateEquation('', []);
    expect(result.ok).toBe(false);
  });
}); // end evaluateEquation describe

describe('closenessToTarget', () => {
  it('returns absolute distance', () => {
    expect(closenessToTarget(19, 20)).toBe(1);
    expect(closenessToTarget(21, 20)).toBe(1);
    expect(closenessToTarget(-5, 1)).toBe(6);
  });

  it('returns 0 for exact match', () => {
    expect(closenessToTarget(1, 1)).toBe(0);
    expect(closenessToTarget(20, 20)).toBe(0);
  });
});

describe('buildCardMultiset', () => {
  it('separates number values from operator strings', () => {
    const cards: Card[] = [numCard(3), numCard(7), opCard('+'), opCard('÷')];
    const { numbers, operators } = buildCardMultiset(cards);
    expect(numbers).toEqual([3, 7]);
    expect(operators).toEqual(['+', '÷']);
  });

  it('returns empty arrays for empty input', () => {
    const { numbers, operators } = buildCardMultiset([]);
    expect(numbers).toEqual([]);
    expect(operators).toEqual([]);
  });
});
