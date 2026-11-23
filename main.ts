// Spike-bank + dip-rebuy: a low-turnover trend bot for the make.fun BTC race
// (btc-race-24h-20261123-0511). Long only, cbBTC/USDC, 1-minute bars.
//
// The dev window (1,440 bars, 22-23 Nov 2026) is one big up-leg (+2.29% in
// its 4th hour) followed by ~19 hours of ~1% chop, with 1-minute noise of
// ~8 bps against a ~26-38 bps full-size round trip. Fast signals whipsaw to
// death on it (the kit's ema-cross baseline: -$114.83 on 76 trades), so this
// bot trades at most a handful of times, and only on moves far larger than
// the round-trip cost:
//
//   1. Entry: buy 100% of cash on the first batch with a 24-bar lookback
//      (batch 24, the momentum baseline's entry). Unconditional, so the bot
//      always makes at least one trade on any window.
//   2. Take-profit: sell everything once the close is 4.5% above the entry
//      close (the close of the bar the position first appears on). On the
//      dev window that banks the spike top instead of riding the chop.
//   3. Rebuy: once flat after a take-profit, buy everything back on a 1.5%
//      pullback from the highest close seen while long. Repeatable: every
//      new leg gets its own take-profit at its own entry close x 1.045.
//   4. Breaker: if equity ever falls to 88% of its peak, sell everything and
//      stay flat for the rest of the window (latched). It never fires on the
//      dev window (max drawdown 1.58%); it exists to keep the race-window
//      drawdown far under the 25% guardrail if the race window crashes.
//
// All decisions are exact bigint comparisons (no floats, no clock, no
// randomness), so two runs on the same data produce identical orders.
// max_slippage_bps is 300: the dev window's largest |next open - close|
// move is 19.8 bps, and a full-size fill adds ~2 bps slippage + ~20 bps
// impact, so 300 bps never rejects a sane fill while still bounding a
// disastrous one.
//
// Offline simulator (Python, same rules, same fill model): dev PnL +$45.44
// on 3 trades, max drawdown 1.58%, +$36.19 at doubled fees — against the
// best kit baseline, momentum at +$34.94. Even with no rebuy the same rules
// score ~+$39, so the verdict does not depend on the rebuy triggering.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// Entry lookback: 24 bars. One full hour of 1-minute bars is enough for
// the trend to show itself while still entering early in the window; the
// momentum baseline enters on the same batch.
/** First batch with a 24-bar lookback (and past any warm-up). */
const ENTRY_LOOKBACK = 24;
// Take-profit: 4.5% above the entry close. Far above the ~26-38 bps
// round-trip cost and above any single hourly rally on the dev window, so
// it only fires after a genuine multi-hour spike — banking the top
// instead of riding the chop that follows.
/** Take-profit: sell when close >= entry close x 1.045. */
const TAKE_PROFIT_NUM = 1045n;
const TAKE_PROFIT_DEN = 1000n;
// Rebuy threshold: 1.5% below the peak close. That is larger than the
// sub-1% hourly dips of the dev window's flat hours, so a rebuy only fires
// on a pullback deeper than the usual chop — and far below the 4.5%
// take-profit, so the round trip still banks a gain even after fees.
/** Rebuy: buy back when close <= peak close x 0.985. */
const REBUY_NUM = 985n;
const REBUY_DEN = 1000n;
// Breaker: 12% below peak equity. Far inside the 25% drawdown guardrail
// the race enforces, so tripping it still leaves the entry ranked above
// every entry that breaches the guardrail — and, latched, it can never
// re-enter and dig deeper.
/** Breaker: exit when equity <= peak equity x 0.88. */
const BREAKER_NUM = 88n;
const BREAKER_DEN = 100n;
// Slippage cap, in basis points, attached to every order the bot sends.
// The replay fills at the NEXT bar's open, so the fill price can jump away
// from the close the bot decided on. 300 bps is about six times the worst
// all-in fill move on the dev window (~45 bps), so a normal fill is never
// refused for slippage, while a fill that would print far from the decision
// price on a violent gap bar still gets rejected instead of executed.
/** Wide enough to never reject a sane 1-minute fill, tight enough to bound a bad one. */
const MAX_SLIPPAGE_BPS = 300;

// How the bot remembers where it is. Four numbers carry the whole session:
// the entry close of the current leg, the highest close seen while long,
// the highest equity seen at any close, and whether the breaker has fired.
// Each has exactly one writer, so the behaviour can be traced bar by bar
// from the action log alone, with no hidden state.
/** Close of the bar the current leg's position first appeared on; null while flat before the first leg. */
let entryClose: bigint | null = null;
/** Highest close seen while long (never reset: any leg that takes profit necessarily exceeds the prior peak). */
let peakClose: bigint | null = null;
/** Highest equity (cash + position at latest close) seen so far. */
let peakEquity: bigint | null = null;
/** Breaker latched: once tripped, the bot stays flat. */
let broken = false;

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    const close = state.close(SYMBOL);
    // No bar for our symbol in this batch: order nothing and leave the
    // state untouched. This should not happen on the race window, but the
    // protocol allows it, and replying with no orders is always legal.
    if (close === null) return [];
    // Refresh the equity peak from this bar BEFORE testing the breaker, so
    // a fresh high can never trip the breaker on the very bar that made it.
    if (peakEquity === null || state.equity > peakEquity) peakEquity = state.equity;

    const position = state.positions.get(SYMBOL);
    const qty = position === undefined ? 0n : BigInt(position.qty);

    // Circuit breaker: a 12% equity drawdown ends the session, and the
    // latch is deliberate — once the bot has decided the window turned
    // against it, it does not try to re-enter on a bounce. A -12% finish
    // cannot place anyway, so the only thing left to protect is the 25%
    // drawdown guardrail. This runs before any trading logic, so a crash
    // exits the position even mid-leg; the sell below fires exactly once,
    // because after it the quantity is zero and every later batch orders
    // nothing.
    if (!broken && state.equity * BREAKER_DEN <= peakEquity * BREAKER_NUM) broken = true;
    if (broken) {
      return qty > 0n
        ? [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }]
        : [];
    }

    if (qty > 0n) {
      // Long. The entry close is stamped only on the first batch the
      // position is seen — the bar after the buy filled at that bar's
      // open — so the take-profit is measured from the close the leg is
      // actually standing on, not from the fill price. The peak is the
      // highest close seen while long and is never reset between legs: a
      // leg can only take profit by printing a close above the old peak,
      // so the peak is always fresh when a rebuy is considered later.
      if (entryClose === null) entryClose = close;
      if (peakClose === null || close > peakClose) peakClose = close;
      if (close * TAKE_PROFIT_DEN >= entryClose * TAKE_PROFIT_NUM) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat.
    if (peakClose !== null && close * REBUY_DEN <= peakClose * REBUY_NUM) {
      // Flat after a take-profit, and the close has pulled back 1.5% from
      // the peak: buy the dip back, full size. Clearing entryClose first
      // is what gives the new leg its own take-profit — the next batch
      // stamps a fresh entry close, and the profit target is measured
      // from that close rather than from the old leg's entry.
      entryClose = null;
      return buyAll(state);
    }
    if (peakClose === null && state.seq >= Math.max(ENTRY_LOOKBACK, state.warmupBars)) {
      // First leg: buy everything on the first batch with a 24-bar
      // lookback. Unconditional by design — the bot needs at least one
      // trade to be ranked at all, and a 24-bar lookback means it enters
      // on the trend the window has already shown rather than on
      // one-minute noise. The warmup guard is belt-and-braces: warmupBars
      // is 0 on this kit, but the rule keeps the bot legal on any window.
      return buyAll(state);
    }
    return [];
  },
});

// Full-size sizing: when the edge exists it lives in the big slow move, so
// the bot bets all of it instead of scaling in. The minimum-notional
// guard only bites after fees have nibbled the cash below the exchange
// minimum — then ordering nothing beats sending an order the replay
// would reject.
/** Buy with all available cash (at least the minimum notional), or nothing. */
function buyAll(state: BarsState): OrderInput[] {
  const cash = state.cash;
  if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}
