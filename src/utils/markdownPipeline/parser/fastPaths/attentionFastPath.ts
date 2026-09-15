/**
 * Purpose: stop an emphasis closer that has no possible opener from walking
 * back to the start of the paragraph.
 *
 * micromark resolves `*`/`_` in one `resolveAll` pass: for every sequence that
 * can close, it walks back event by event looking for one that can open. A
 * closer with nothing to find walks all the way — so `a_ ` repeated n times,
 * where every `_` closes and none opens, is O(n²). Measured at the soak's scale
 * (#1407): 27s to parse and 44s to serialize.
 *
 * The exact, cheap observation: that walk can only ever match a sequence that
 * can OPEN, with the SAME marker, EARLIER in the paragraph — and resolving never
 * creates an opener, it only consumes them. So a closer with no same-marker
 * opener anywhere before it is guaranteed to match nothing. One forward pass
 * finds those closers; their `_close` flag is lowered for the duration of the
 * stock resolver, so its outer loop skips the walk; then it is restored.
 *
 * Only closers that CANNOT also open are touched. A both-flanking sequence's
 * `_close` flag is also read when it acts as an opener (the rule of three), so
 * lowering it could change a later match.
 *
 * Mechanism: `attention` is disabled by name and this wrapper takes its place
 * at `*` and `_`. The wrapper tokenizes with micromark's own `attention`
 * tokenizer — looked up from the parser, not imported — and resolves with its
 * own resolver around the prefilter. Link text inside a label is still resolved
 * by the stock resolver through `insideSpan`, exactly as before.
 *
 * PLACE matters, unlike for the `]` and backtick fast paths: this wrapper
 * SUCCEEDS, so whichever construct micromark tries first at `_` wins. GFM's
 * email autolink is registered ahead of `attention` there, and a wrapper added
 * in front of both turned `(_A_@_.A` from a link into emphasis — the
 * equivalence test (`inlineFastPaths.test.ts`) caught exactly that. So the
 * wrapper is added AFTER, and refuses loudly to run anywhere but directly
 * behind the disabled stock construct, where the order of everything
 * micromark tries is unchanged.
 *
 * Known limitation: sequences that DO pair up still cost O(span) per match —
 * micromark re-resolves the text between opener and closer and splices the
 * event list — so deeply nested emphasis stays quadratic in its depth.
 *
 * @coordinates-with micromarkTypes.ts — the tokenizer API slice used here
 * @coordinates-with remarkInlineFastPaths.ts — registers this construct
 * @module utils/markdownPipeline/parser/fastPaths/attentionFastPath
 */
import type {
  Construct,
  Effects,
  Event,
  ParseContext,
  State,
  Token,
  TokenizeContext,
} from "./micromarkTypes";

const ASTERISK = 42;
const UNDERSCORE = 95;
export const STOCK_ATTENTION = "attention";
const NAME = "vmarkAttention";

const placementChecked = new WeakSet<ParseContext>();

/** Everything micromark registered at `code`, disabled or not, in try order. */
function registeredAt(parser: ParseContext, code: number): Construct[] {
  const registered = parser.constructs.text[code];
  return Array.isArray(registered) ? registered : registered ? [registered] : [];
}

/**
 * micromark's own `attention` construct, found by name in the parser — after
 * confirming, once per parser, that the wrapper sits in its place.
 *
 * Returns undefined when there is no stock construct to wrap: then nothing was
 * disabled by that name either, and declining is exactly the stock behaviour.
 */
function stockAttention(parser: ParseContext): Construct | undefined {
  const stock = registeredAt(parser, ASTERISK).find((c) => c.name === STOCK_ATTENTION);
  if (!stock || placementChecked.has(parser)) return stock;
  const disabled = parser.constructs.disable.null ?? [];
  for (const code of [ASTERISK, UNDERSCORE]) {
    const list = registeredAt(parser, code);
    const from = list.indexOf(stock);
    const to = list.findIndex((c) => c.name === NAME);
    const between = list.slice(from + 1, to);
    if (from < 0 || to < from || between.some((c) => !(c.name && disabled.includes(c.name)))) {
      throw new Error(
        `[MarkdownPipeline] ${NAME} is not directly behind micromark's attention at ` +
          `character ${code}; it would change which construct wins there. Register ` +
          `remarkInlineFastPaths before any plugin that appends constructs at * or _.`,
      );
    }
  }
  placementChecked.add(parser);
  return stock;
}

function tokenizeAttention(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
): State {
  const stock = stockAttention(this.parser);
  if (!stock) return nok;
  return stock.tokenize.call(this, effects, ok, nok);
}

function resolveAllAttention(events: Event[], context: TokenizeContext): Event[] {
  const stock = stockAttention(context.parser);
  if (!stock?.resolveAll) return events;

  const muted: Token[] = [];
  const opened = new Set<number>();
  for (const [kind, token] of events) {
    if (kind !== "enter" || token.type !== "attentionSequence") continue;
    const marker = context.sliceSerialize(token).charCodeAt(0);
    if (token._close && !token._open && !opened.has(marker)) {
      token._close = false;
      muted.push(token);
    }
    if (token._open) opened.add(marker);
  }

  try {
    return stock.resolveAll(events, context);
  } finally {
    for (const token of muted) token._close = true;
  }
}

/** Takes `attention`'s place at `*` and `_`; see the header. */
export const attentionWithoutFutileWalks: Construct = {
  name: NAME,
  add: "after",
  tokenize: tokenizeAttention,
  resolveAll: resolveAllAttention,
};
