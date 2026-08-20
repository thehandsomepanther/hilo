/**
 * Equation parser and evaluator.
 *
 * Accepted operators: + - × ÷ √
 * Also accepts * for × and / for ÷ for ease of input.
 *
 * Operator precedence (high → low):
 *   √  (unary prefix, applies to the single number that follows)
 *   × ÷
 *   + -
 *
 * There are no parentheses: grouping is not part of the game, so a `Token`
 * cannot represent one and the grammar has nowhere to put one.  Precedence
 * alone decides how an equation evaluates.  This is not merely cosmetic — the
 * card UI has no way to enter a bracket, so accepting them would only ever
 * benefit someone hand-crafting a submission over the wire.
 *
 * Results may be any real number (including negative).
 * Division by zero is a runtime error.
 */

import { Card } from './types';

// ─── Tokeniser ────────────────────────────────────────────────────────────────

type TokNum = { type: 'num'; value: number };
type TokOp = { type: 'op'; op: '+' | '-' | '×' | '÷' | '√' };
type Token = TokNum | TokOp;

function tokenise(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = expr.trim();

  while (i < s.length) {
    const ch = s.charAt(i);
    if (/\s/.test(ch)) { i++; continue; }

    if (/\d/.test(ch)) {
      let num = '';
      while (i < s.length && /\d/.test(s.charAt(i))) num += s.charAt(i++);
      tokens.push({ type: 'num', value: parseInt(num, 10) });
      continue;
    }

    if (ch === '+') { tokens.push({ type: 'op', op: '+' }); i++; continue; }
    if (ch === '-') { tokens.push({ type: 'op', op: '-' }); i++; continue; }
    if (ch === '*' || ch === '×') { tokens.push({ type: 'op', op: '×' }); i++; continue; }
    if (ch === '/' || ch === '÷') { tokens.push({ type: 'op', op: '÷' }); i++; continue; }
    if (ch === '√') { tokens.push({ type: 'op', op: '√' }); i++; continue; }

    // Called out separately from the generic error: brackets are the one
    // wrong-but-plausible thing someone might reach for.
    if (ch === '(' || ch === ')') {
      throw new Error('Parentheses are not allowed — operator precedence decides the order');
    }

    throw new Error(`Unknown character: '${ch}'`);
  }

  return tokens;
}

// ─── Recursive-descent parser ─────────────────────────────────────────────────

/**
 * Grammar:
 *   expr  := term  (('+' | '-') term)*
 *   term  := unary (('×' | '÷') unary)*
 *   unary := '√'? NUM
 *
 * The only operand is a number literal, which is what enforces the rule that
 * "Square Root cards can only be used on a single number" — there is no
 * sub-expression for √ to reach into.  It also means √'s operand is always a
 * card value in 0–10, so it can never be negative.
 */
class Parser {
  private pos = 0;
  /** Numbers consumed in order during parsing — used for card validation. */
  readonly numbersUsed: number[] = [];
  /** Operators consumed — used for card validation. */
  readonly operatorsUsed: string[] = [];

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const val = this.expr();
    if (this.pos < this.tokens.length) {
      throw new Error('Unexpected token after expression end');
    }
    return val;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const t = this.tokens[this.pos++];
    if (t === undefined) throw new Error('Unexpected end of expression');
    return t;
  }

  private expr(): number {
    let left = this.term();
    while (true) {
      const t = this.peek();
      if (t?.type === 'op' && (t.op === '+' || t.op === '-')) {
        this.pos++;
        this.operatorsUsed.push(t.op);
        const right = this.term();
        left = t.op === '+' ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  }

  private term(): number {
    let left = this.unary();
    while (true) {
      const t = this.peek();
      if (t?.type === 'op' && (t.op === '×' || t.op === '÷')) {
        this.pos++;
        this.operatorsUsed.push(t.op);
        const right = this.unary();
        if (t.op === '÷') {
          if (right === 0) throw new Error('Division by zero');
          left = left / right;
        } else {
          left = left * right;
        }
      } else {
        break;
      }
    }
    return left;
  }

  private unary(): number {
    const t = this.peek();
    if (t?.type === 'op' && t.op === '√') {
      this.pos++;
      this.operatorsUsed.push('√');
      // The operand is a card value in 0–10, so the root is always real.
      return Math.sqrt(this.numberLiteral());
    }
    return this.numberLiteral();
  }

  private numberLiteral(): number {
    const t = this.consume();
    if (t.type !== 'num') {
      throw new Error(`Expected a number, got '${t.op}'`);
    }
    this.numbersUsed.push(t.value);
    return t.value;
  }
}

// ─── Card-set helpers ─────────────────────────────────────────────────────────

export function buildCardMultiset(cards: Card[]): {
  numbers: number[];
  operators: string[];
} {
  const numbers: number[] = [];
  const operators: string[] = [];
  for (const c of cards) {
    if (c.kind === 'number') numbers.push(c.value);
    else operators.push(c.operator);
  }
  return { numbers, operators };
}

function sortedNumbers(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}

function sortedStrings(arr: string[]): string[] {
  return [...arr].sort();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type EvaluationResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Evaluate an equation string, validating that the numbers and operators
 * used exactly match `availableCards`.
 *
 * `availableCards` should be all cards the player holds:
 *   secretCard + faceUpCards + personalOperators
 */
export function evaluateEquation(
  expression: string,
  availableCards: Card[],
): EvaluationResult {
  try {
    const tokens = tokenise(expression);
    const parser = new Parser(tokens);
    const value = parser.parse();

    const { numbers: availNums, operators: availOps } = buildCardMultiset(availableCards);

    if (sortedNumbers(parser.numbersUsed).join(',') !== sortedNumbers(availNums).join(',')) {
      return {
        ok: false,
        error:
          `Numbers used [${parser.numbersUsed.join(', ')}] ` +
          `do not match hand [${availNums.join(', ')}]`,
      };
    }

    if (sortedStrings(parser.operatorsUsed).join(',') !== sortedStrings(availOps).join(',')) {
      return {
        ok: false,
        error:
          `Operators used [${parser.operatorsUsed.join(', ')}] ` +
          `do not match hand [${availOps.join(', ')}]`,
      };
    }

    if (!isFinite(value)) {
      return { ok: false, error: 'Equation result is not finite' };
    }

    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Absolute distance between a result and a target. */
export function closenessToTarget(result: number, target: number): number {
  return Math.abs(result - target);
}
