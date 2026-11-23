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
/** First batch with a 24-bar lookback (and past any warm-up). */
const ENTRY_LOOKBACK = 24;
/** Take-profit: sell when close >= entry close x 1.045. */
const TAKE_PROFIT_NUM = 1045n;
const TAKE_PROFIT_DEN = 1000n;
/** Rebuy: buy back when close <= peak close x 0.985. */
const REBUY_NUM = 985n;
const REBUY_DEN = 1000n;
/** Breaker: exit when equity <= peak equity x 0.88. */
const BREAKER_NUM = 88n;
const BREAKER_DEN = 100n;
/** Wide enough to never reject a sane 1-minute fill, tight enough to bound a bad one. */
const MAX_SLIPPAGE_BPS = 300;

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
    if (close === null) return [];
    if (peakEquity === null || state.equity > peakEquity) peakEquity = state.equity;

    const position = state.positions.get(SYMBOL);
    const qty = position === undefined ? 0n : BigInt(position.qty);

    // Circuit breaker: a 12% equity drawdown ends the session (latched).
    if (!broken && state.equity * BREAKER_DEN <= peakEquity * BREAKER_NUM) broken = true;
    if (broken) {
      return qty > 0n
        ? [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }]
        : [];
    }

    if (qty > 0n) {
      // Long: record the leg's entry and peak, sell on the take-profit.
      if (entryClose === null) entryClose = close;
      if (peakClose === null || close > peakClose) peakClose = close;
      if (close * TAKE_PROFIT_DEN >= entryClose * TAKE_PROFIT_NUM) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat.
    if (peakClose !== null && close * REBUY_DEN <= peakClose * REBUY_NUM) {
      // A 1.5% pullback from the peak: buy the dip back, full size.
      entryClose = null;
      return buyAll(state);
    }
    if (peakClose === null && state.seq >= Math.max(ENTRY_LOOKBACK, state.warmupBars)) {
      // First leg: buy everything on the first batch with a 24-bar lookback.
      return buyAll(state);
    }
    return [];
  },
});

/** Buy with all available cash (at least the minimum notional), or nothing. */
function buyAll(state: BarsState): OrderInput[] {
  const cash = state.cash;
  if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}
