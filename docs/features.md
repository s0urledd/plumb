# Features

Everything the dashboard shows, page by page. The same data is available
from the [API](api.md).

## Overview

- **Headline metrics** for 24h, 7d, 30d and all time. Each card names its
  period; flows over a window are compared with the previous window.
  - volume, open interest and TVL (open interest and TVL are "now");
  - fees, with the protocol's revenue (its share of fees and of
    liquidations) and what it paid out to traders;
  - active traders and new accounts;
  - liquidations.
- **Time series** per hour, four hours, day or week (all time):
  - trading volume stacked by market, per period or cumulative;
  - open interest and TVL;
  - deposits against withdrawals, with the net per period;
  - active traders (new and returning), liquidations by market;
  - fees by market, or by who receives them: the protocol and the insurance
    fund;
  - realized PnL of all traders, and taker buying against selling.

  Every chart downloads as CSV or PNG.
- **Live trades** as they finalize, labelled by what the trader did (open,
  add, reduce, close, flip, liquidated), with a size filter. Trades from
  proposed blocks appear first, dimmed.
- Latest liquidations, the largest depositors and withdrawers, and totals
  across windows.
- **Market share**: Perpl's open interest against other perp venues and
  within Monad, from DefiLlama, labelled as such and never mixed into
  Plumb's own figures.
- The MON price in the header is the mark of Perpl's MON market.

## Markets

- Price and change, volume and share, open interest, funding per 8 h and
  APR, long/short skew, taker buy share, traders, liquidations, cost of a
  $10K market order.
- A markets × time funding map.
- Each market has its own page: candles built from fills with the price
  bands where open positions would be liquidated (click one for its largest
  wallet), positioning, position flow (open interest opened and closed per
  side), entry prices of open positions, the largest open positions, funding
  history with the next funding block, the liquidation ladder, top traders
  and a live tape.

## Traders

- **Positioning by cohort**: open positions grouped by account size (whales
  ≥ $100K open, dolphins, fish, shrimp < $1K) and by track record (top
  winners to rekt), with each cohort's long/short split, bias, unrealized
  PnL, main markets and largest wallets.
- **Smart money moves**: the latest position changes of the top 50 traders
  by net PnL (market makers and high-frequency accounts left out), split
  fills folded into one row, with a size floor.
- **Leaderboard** for any window by net PnL, losses, volume, liquidated
  notional, fees or net inflow, with open positions now; CSV export and
  paging. Net PnL counts what the contract settles, including funding
  realized when a position is increased and the share of margin a
  liquidation keeps.

## Wallets

Search any address or account ID (`/` focuses the search), or click any
trader anywhere.

- **Portfolio** from contract state: account value, free and locked balance,
  margin usage, leverage, distance to the closest liquidation, and every open
  position with entry, mark, unrealized PnL and liquidation price.
- **By period** (24h, 7d, 30d, all time): volume, trades, net PnL, PnL per
  volume, and the wallet's rank by PnL and by volume among every account
  that traded in the same window.
- **Performance** over closed round trips: win rate, profit factor,
  expectancy, largest win and loss, max drawdown with its dates, streaks,
  hold times of winners against losers, long against short, best and worst
  market.
- **PnL** as a cumulative curve, daily bars or a calendar of days.
- **Trade history** with the price, size and fee of the fill behind each
  position change, maker or taker role and realized PnL; CSV export. Round
  trips, deposits and withdrawals have their own tabs; the flows tab also
  lists what the protocol paid to the account.
- **Behaviour**: rule-based notes (trading style, holding losers longer than
  winners, typical leverage, active hours) and a weekday × hour activity map.
- **Watchlist** (on the Alerts page, next to the Telegram bot, with a link
  per wallet that starts watching it there), **compare** up to five wallets (from a wallet page or the watchlist), and a **share card** (a PNG
  summary drawn in the browser).

## Liquidations

Liquidated notional over time by market, the full feed of order-book
liquidations, auto-deleveraging and force closes, with CSV export.

## Risk

Perpl keeps its order book and positions in the contract, so risk is
measured instead of estimated:
- notional at risk if every market moves 5 % or 10 % the same way;
- the liquidation ladder per market;
- bad debt past bankruptcy, and how much of it each market's insurance fund
  covers;
- order-book absorption: resting depth walked from the contract against the
  liquidations a move would force into it;
- the cost of a market order of $1K, $10K and $100K per market;
- an interactive stress test.

These are static price shocks: they show which positions a move would reach,
not a forecast of the liquidations that would execute, which depend on the
path of the price, the book at the time and keepers. Every figure on the page
comes from one contract snapshot and one order-book read (books are re-read
about every 30 s); the page names both blocks.

The API adds the liquidation map, an estimated auto-deleveraging order, the
health of every position and concentration per market.

## Alerts

A Telegram bot, run by the server when `TELEGRAM_BOT_TOKEN` is set. It
long-polls Telegram, so it needs no public endpoint; subscriptions are kept
in ClickHouse. Everything is set from a button menu (`/menu`) or with
commands.

- **Wallets** (`/watch <address or id>`, or just send the address): every
  position change (open, add, reduce, close, flip, liquidation, deleverage)
  with size, price, PnL and the transaction, and a warning as a position
  nears its liquidation price. Warning levels are per chat: early (20%, 10%,
  5% away), standard (10%, 5%) or late (5%, 2%); checked each minute against
  contract state, one message per level, re-armed once the position
  recovers. Up to 20 wallets per chat.
- **My positions** (`/positions`): the watched wallets' open positions now,
  closest to liquidation first, with value, PnL, leverage and distance.
- **Liquidations** and **large trades** above a size picked from the menu or
  set with `/liqs 25k BTC`, `/trades 100k` (optionally for one market).
- **Funding flips**: a message when a market's funding changes direction.

The Alerts page (`/alerts`) introduces the bot above the watchlist. The wallet page and each watchlist row link to the bot with the wallet pre-filled
(`t.me/<bot>?start=watch_<address>`). Events more than five minutes old,
such as those replayed after downtime, are not sent. The bot sets its own
command list and profile text on start.

## Status

The data pipeline (live ingest, backfill, rollups), the integrity check
against the contract (open interest, TVL and the protocol balance rebuilt
from launch), the decoder's counters and which feed woke the last update.
