import { describe, it, expect } from 'vitest';
import { buildDeck, buildPersonalOperators, shuffle, drawCard, drawNumberCard } from '../deck';

describe('buildDeck', () => {
  it('produces 52 cards', () => {
    expect(buildDeck()).toHaveLength(52);
  });

  it('contains 44 number cards (0-10 in 4 suits)', () => {
    const deck = buildDeck();
    const numCards = deck.filter((c) => c.kind === 'number');
    expect(numCards).toHaveLength(44);
  });

  it('contains 4 × cards and 4 √ cards', () => {
    const deck = buildDeck();
    const ops = deck.filter((c) => c.kind === 'operator');
    expect(ops.filter((c) => c.kind === 'operator' && c.operator === '×')).toHaveLength(4);
    expect(ops.filter((c) => c.kind === 'operator' && c.operator === '√')).toHaveLength(4);
  });
});

describe('buildPersonalOperators', () => {
  it('returns +, -, ÷', () => {
    const ops = buildPersonalOperators();
    expect(ops).toHaveLength(3);
    const symbols = ops.map((o) => o.operator);
    expect(symbols).toContain('+');
    expect(symbols).toContain('-');
    expect(symbols).toContain('÷');
  });
});

describe('shuffle', () => {
  it('preserves length', () => {
    const deck = buildDeck();
    expect(shuffle(deck)).toHaveLength(deck.length);
  });

  it('does not mutate original', () => {
    const deck = buildDeck();
    const original = [...deck];
    shuffle(deck);
    expect(deck).toEqual(original);
  });
});

describe('drawCard', () => {
  it('returns top card and shorter deck', () => {
    const deck = buildDeck();
    const { card, remaining } = drawCard(deck);
    expect(card).toBe(deck[0]);
    expect(remaining).toHaveLength(deck.length - 1);
  });

  it('throws on empty deck', () => {
    expect(() => drawCard([])).toThrow('Deck is empty');
  });
});

describe('drawNumberCard', () => {
  it('always returns a number card', () => {
    const deck = buildDeck();
    const { card } = drawNumberCard(deck);
    expect(card.kind).toBe('number');
  });

  it('throws when no number cards remain', () => {
    const onlyOps = buildDeck().filter((c) => c.kind === 'operator');
    expect(() => drawNumberCard(onlyOps)).toThrow();
  });

  it('skips over operator cards at the front of the deck', () => {
    // Put an operator at the front, then number cards
    const opsFirst = [
      ...buildDeck().filter((c) => c.kind === 'operator').slice(0, 2),
      ...buildDeck().filter((c) => c.kind === 'number'),
    ];
    const { card } = drawNumberCard(opsFirst);
    expect(card.kind).toBe('number');
  });
});

describe('buildDeck — card composition', () => {
  it('contains all four suits for each number value', () => {
    const deck = buildDeck();
    const suits = ['Gold', 'Silver', 'Bronze', 'Black'] as const;
    for (let v = 0; v <= 10; v++) {
      for (const suit of suits) {
        const found = deck.some(
          (c) => c.kind === 'number' && c.value === v && c.suit === suit,
        );
        expect(found, `Missing ${v}(${suit})`).toBe(true);
      }
    }
  });

  it('does not contain + − ÷ (those are personal operators, not in the draw deck)', () => {
    const deck = buildDeck();
    const illegalOps = deck.filter(
      (c) => c.kind === 'operator' && (c.operator === '+' || c.operator === '-' || c.operator === '÷'),
    );
    expect(illegalOps).toHaveLength(0);
  });
});
