import { Card, NumberCard, OperatorCard, Suit } from './types';

const SUITS: Suit[] = ['Gold', 'Silver', 'Bronze', 'Black'];
const NUMBER_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** Build the 52-card main deck (44 number cards + 4× + 4√). */
export function buildDeck(): Card[] {
  const cards: Card[] = [];

  for (const suit of SUITS) {
    for (const value of NUMBER_VALUES) {
      cards.push({ kind: 'number', value, suit });
    }
  }

  for (let i = 0; i < 4; i++) {
    cards.push({ kind: 'operator', operator: '×' });
    cards.push({ kind: 'operator', operator: '√' });
  }

  return cards;
}

/** Return the three personal operator cards dealt to each player at game start. */
export function buildPersonalOperators(): OperatorCard[] {
  return [
    { kind: 'operator', operator: '+' },
    { kind: 'operator', operator: '-' },
    { kind: 'operator', operator: '÷' },
  ];
}

/** Fisher-Yates shuffle — returns a new array. */
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}

/** Draw the top card from the deck. Throws if empty. */
export function drawCard(deck: Card[]): { card: Card; remaining: Card[] } {
  if (deck.length === 0) throw new Error('Deck is empty');
  const card = deck[0] as Card;
  return { card, remaining: deck.slice(1) };
}

/**
 * Draw cards until a NumberCard is found, returning it along with the
 * remaining deck (discarded non-number cards are gone).
 */
export function drawNumberCard(deck: Card[]): { card: NumberCard; remaining: Card[] } {
  let remaining = [...deck];
  while (remaining.length > 0) {
    const result = drawCard(remaining);
    remaining = result.remaining;
    if (result.card.kind === 'number') {
      return { card: result.card as NumberCard, remaining };
    }
    // non-number card: discard and reshuffle to avoid positional bias
    remaining = shuffle(remaining);
  }
  throw new Error('No number cards left in deck');
}
