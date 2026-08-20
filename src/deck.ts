import { Card, NumberCard, OperatorCard, Suit } from './types';

const SUITS: Suit[] = ['Gold', 'Silver', 'Bronze', 'Black'];
const NUMBER_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** Number cards in the deck — the resource that limits table size. */
const NUMBER_CARD_COUNT = SUITS.length * NUMBER_VALUES.length;

/**
 * Number cards a single player consumes in one round, which is a fixed 4 no
 * matter how the deal goes: 1 secret, 2 in dealing phase 1, 1 in phase 2.
 *
 * Phase 1 is 2 regardless of symbols because a √ or accepted × eats both of
 * that player's draw slots and pays out a bonus number plus a forced extra;
 * a declined × pays a bonus number and sends the player to the second pass.
 * Operator cards drawn along the way are discarded without costing numbers.
 */
const NUMBER_CARDS_PER_PLAYER = 4;

/**
 * Most players one deck can seat.  Past this, dealing runs the deck dry and
 * `drawCard`/`drawNumberCard` throw part-way through a deal, which would leave
 * the game in a broken half-dealt state.  There is no slack: 11 players use
 * every one of the 44 number cards.
 */
export const MAX_PLAYERS = Math.floor(NUMBER_CARD_COUNT / NUMBER_CARDS_PER_PLAYER);

/** Fewest players a game can start with. */
export const MIN_PLAYERS = 2;

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
 * Draw cards until an eligible NumberCard is found, returning it along with
 * the remaining deck (discarded operator cards are gone).
 *
 * Number cards whose value is in `excludeValues` are skipped and returned to
 * the bottom of the remaining deck (shuffled in). Operator cards are discarded.
 */
export function drawNumberCard(
  deck: Card[],
  excludeValues: ReadonlySet<number> = new Set(),
): { card: NumberCard; remaining: Card[] } {
  let remaining = [...deck];
  const putBack: NumberCard[] = [];
  while (remaining.length > 0) {
    const result = drawCard(remaining);
    remaining = result.remaining;
    if (result.card.kind === 'number') {
      if (!excludeValues.has(result.card.value)) {
        const finalRemaining = putBack.length > 0
          ? shuffle([...remaining, ...putBack])
          : remaining;
        return { card: result.card as NumberCard, remaining: finalRemaining };
      }
      putBack.push(result.card as NumberCard);
    } else {
      // operator card: discard and reshuffle to avoid positional bias
      remaining = shuffle(remaining);
    }
  }
  throw new Error('No eligible number cards left in deck');
}
