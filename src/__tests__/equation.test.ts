import { describe, it, expect } from 'vitest';
import { evaluateEquation, closenessToTarget } from '../equation';
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

  it('supports parentheses', () => {
    const cards: Card[] = [numCard(2), numCard(3), numCard(4), opCard('+'), opCard('×')];
    const result = evaluateEquation('(2 + 3) × 4', cards);
    expect(result).toEqual({ ok: true, value: 20 });
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

  it('rejects √ of negative', () => {
    // We simulate it with subtraction result going negative — but √ is on a
    // literal number, so construct a case where we try √ on 0 after arithmetic.
    // The parser applies √ to the primary that immediately follows, so:
    // √(1 - 4) — but with our grammar √ binds to a primary, so √ (1-4)
    // would be √ applied to parenthesised expression.
    const cards: Card[] = [numCard(1), numCard(4), opCard('√'), opCard('-')];
    const result = evaluateEquation('√(1 - 4)', cards);
    expect(result.ok).toBe(false);
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
});

describe('closenessToTarget', () => {
  it('returns absolute distance', () => {
    expect(closenessToTarget(19, 20)).toBe(1);
    expect(closenessToTarget(21, 20)).toBe(1);
    expect(closenessToTarget(-5, 1)).toBe(6);
  });
});
