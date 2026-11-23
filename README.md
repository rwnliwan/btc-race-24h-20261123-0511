[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/rwnliwan/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/rwnliwan/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# Spike-bank + dip-rebuy — BTC trading bot

Entry for the make.fun competition ["Race a BTC trading bot live for 24 hours"](https://make.fun/bounty/btc-race-24h-20261123-0511): a low-turnover trend bot that trades cbBTC/USDC on 1-minute bars.

## Strategy

The dev window (1,440 bars, 22–23 Nov 2026) is one big up-leg (+2.29% in its 4th hour) followed by ~19 hours of ~1% chop, with 1-minute noise of ~8 bps against a ~26–38 bps full-size round trip. Fast signals whipsaw to death on it (the kit's ema-cross baseline: −$114.83 on 76 trades), so this bot trades at most a handful of times, and only on moves far larger than the round-trip cost:

1. **Entry** — buy 100% of cash on the first batch with a 24-bar lookback (batch 24, the momentum baseline's entry). Unconditional, so the bot always makes at least one trade on any window.
2. **Take-profit** — sell everything once the close is 4.5% above the entry close (the close of the bar the position first appears on). On the dev window that banks the spike top instead of riding the chop.
3. **Rebuy** — once flat after a take-profit, buy everything back on a 1.5% pullback from the highest close seen while long. Repeatable: every new leg gets its own take-profit at its own entry close × 1.045.
4. **Breaker** — if equity ever falls to 88% of its peak, sell everything and stay flat for the rest of the window (latched). It never fires on the dev window (max drawdown 1.58%); it exists to keep the race-window drawdown far under the 25% guardrail if the race window crashes.

All decisions are exact bigint comparisons (no floats, no clock, no randomness), so two runs on the same data produce identical orders. `max_slippage_bps` is 300: the dev window's largest |next open − close| move is 19.8 bps, and a full-size fill adds ~2 bps slippage + ~20 bps impact, so 300 bps never rejects a sane fill while still bounding a disastrous one.

## Results (offline simulator, same rules, same fill model)

| | dev PnL | trades | max drawdown | PnL at 2x fees |
|---|---|---|---|---|
| This bot | **+$45.44** | 3 | 1.58% | +$36.19 |
| momentum (best kit baseline) | +$34.94 | 1 | 1.98% | +$34.11 |
| buy-and-hold | +$32.17 | 1 | 1.98% | +$31.34 |

Even with no rebuy the same rules score ~+$39, so the result does not depend on the rebuy triggering. Full trial log (every candidate tested, including the Tideguard v2 rules from an external reviewer, which scored +$28.47 in the same simulator and were not used): see `trial-log.md` in the build workspace (not shipped in this repo).

## Run

```sh
# from inside the unpacked kit
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver process --json
```

`main.ts` is the entrypoint (Node 22, type stripping, stdlib only). `vendor/makefun-bars.ts` is a byte-identical copy of the kit's SDK shim, as the kit's rules allow. No network, no wall clock, no files outside the repo, deterministic.
