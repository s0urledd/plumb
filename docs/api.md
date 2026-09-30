# HTTP API

All routes are `GET`, read-only, JSON unless noted, gzip-compressed and served
with `access-control-allow-origin: *`. Amounts are decimal strings in USD
(AUSD) or in the market's units; they are exact and should be parsed as
decimals, not floats. Times are Unix seconds (UTC).

Analytics responses have a `meta` object with the last indexed block
(`block`, `ts`) and, for windowed routes, the window and its `coverage`:
`complete: false` means history for part of the window is still being
indexed (`/integrity` has no `meta`). Risk routes carry a `snapshot` with the
contract block, hash, block time, contract version, status (with a reason
when stale) and the age of both the last poll (`age_ms`) and the block
(`block_age_ms`).

Errors: `{ "error": "CODE" }` with 400 (bad parameter), 404 (unknown market,
account or route), 429 (`RATE_LIMITED`, with `retry-after`) or 503 (`SYNCING`
before the first contract snapshot).

Rate limit: each client IP has a token bucket (default 600 requests a minute,
bursts of 120). A plain read costs 1, first-load wallet analytics 3, CSV
exports and `/compare` 10; `/health` is free. Behind a reverse proxy on the
same host the client is the last `X-Forwarded-For` entry.

## Protocol

| Route | Parameters | Returns |
| --- | --- | --- |
| `/api/v1/protocol` | `window` = `24h` (default), `7d`, `30d`, `90d`, `all` | `headline`, the window's totals. Volume, trades (position changes of both sides), fees, protocol and insurance fees, protocol revenue, traders, new accounts, deposits, withdrawals, net flow, liquidations and liquidated notional carry `value`, `prev` (the previous window of the same length) and `change_pct`; builder fees (part of the protocol fees), take rate, deleverages, taker buy share and realized PnL are plain values. Fees are gross; `protocol_fees` + `insurance_fees` = `fees`, reducing fills included. `revenue`: `protocol` and `insurance`, each with `total`, `opening_fees`, `reducing_fees` and `liquidations` (their shares of fees on opening and on reducing fills and of liquidations), `builder_fees` (inside the protocol share, owed to builders) and `unsplit_liquidations`, the number of liquidations whose split is not verified (partial or off the book) and not counted; every other `revenue` value is a USD amount (the headline's `liquidations` is a count). `protocol_revenue.value` equals `revenue.protocol.total`. Since 2026-09-28 `protocol_fees` and `insurance_fees` include the split of reducing fills; before, they covered opening fills only and `fees` minus both was the unsplit rest. Payouts and sweeps between the protocol and accounts are not revenue (see the methodology): `protocol_payouts` (`value`, `prev`, `change_pct`: paid from the protocol balance to accounts), `payout_count` and `protocol_sweeps` (moved from accounts into it) report them. `current`: contract state now, i.e. open interest, TVL, insurance, positions, accounts. `markets[]`: volume and share, `fills` (matches, each counted once), `trades` (position changes), traders, fees, protocol and insurance fees, `revenue` (as in the headline), OHLC and change, taker buy share, liquidations, plus live mark, open interest, long/short positions, funding, OI cap, `spread_bps` and `cost_10k_bps` (mean cost of buying and selling $10K at market, from the on-chain book). `windows`: 24h, 7d, 30d and all-time totals, keyed by window |
| `/api/v1/protocol/series` | `window`, `bucket` = `1h`, `4h`, `1d`, `1w` (default by window), `market` | `times[]` and `points[]` per bucket: volume, trades, fees, protocol and insurance fees, `revenue` (as in `/protocol`), taker buy and sell, liquidations, realized PnL, open interest; exchange-wide also traders, new traders (first trade ever), deposits, withdrawals, net flow, new accounts, TVL, `protocol_payouts`; for one market also OHLC. `by_market[]` has volume, liquidated notional and fees per market. `meta.cumulative_complete` says whether open interest and TVL are available (history contiguous from launch) |
| `/api/v1/trades` | `limit` ≤ 200 (default 50), `market` | Latest taker-side trades: kind (`open`, `increase`, `decrease`, `close`, `invert`, `liquidation`), side, buy, price, size, notional, fee (for a liquidation, including the liquidation fee), PnL (realized, funding included), account and address, `on_book`, `force_close` |
| `/api/v1/liquidations` | `limit` ≤ 500 (10,000 as CSV), `offset`, `market`, `window`, `format=csv` | Liquidations and deleverages, newest first. With `window`: only that window, its `total` for paging and its `largest` liquidation. `last_24h` totals |
| `/api/v1/funding` | `window` (default `7d`) | Per market: current rate per interval, 8 h and APR equivalents, interval length, positions and open interest; `series` of funding rates over the window |
| `/api/v1/flows` | `window` | Top ten depositors and withdrawers in the window and the 30 latest transfers. Window totals are in `/protocol` (`deposits`, `withdrawals`, `net_flow`) |
| `/api/v1/leaderboard` | `window` (also `this_epoch`, `last_epoch`), `by` = `pnl`, `loss`, `volume`, `realized`, `fees`, `trades`, `liquidated`, `deposits`, `withdrawals`, `net_flow`; `market`, `limit` ≤ 200, `offset`, `format=csv` | Accounts that traded in the window (for `deposits`, `withdrawals`: accounts with that flow; `net_flow`: with either), ranked; ties share a rank. Net PnL (realized − fees), realized, fees, volume, maker share, trades, PnL per volume, liquidations, flows, markets traded, open positions and unrealized PnL now; `total` accounts With an epoch window, `meta.volume` and `meta.blocks`, and each row's `volume_share_pct`. |
| `/api/v1/search` | `q`: address, address prefix or account ID | Up to eight matching accounts |

## Wallets

`:key` is a `0x` address or an account ID.

| Route | Parameters | Returns |
| --- | --- | --- |
| `/api/v1/wallets/:key` | | `account` (id, address, creation time); `summary` (all-time volume, trades, realized, fees, net PnL, funding, liquidations, deposits, withdrawals, first and last trade, active days, maker share, `payouts_received` and `payout_count` (paid to the account from the protocol balance), `swept_to_protocol`); `markets[]`; `pnl_daily[]` (net and cumulative); `recent_trades[]`; `flows[]` (kinds `deposit`, `withdrawal`, `payout`, `sweep`); `portfolio` (contract `block`; `balance`, which includes what open orders lock; `available_balance`; `locked_balance`; position margin; account value = balance + equity of open positions; unrealized PnL; margin usage; leverage; closest liquidation) and `positions[]`, both at the same block |
| `/api/v1/wallets/:key/analytics` | | `performance` over closed round trips: win rate, profit factor, expectancy, largest win and loss, max drawdown with dates, streaks, hold times (all, winners, losers), long and short splits, best and worst market, per-market results; `insights[]` (rule-based); `activity` (weekday × hour); `trip_curve`; `trips[]` (latest 200) and `open_trips[]`. `performance.based_on` says how many events were used |
| `/api/v1/wallets/:key/periods` | | For 24h, 7d, 30d, all time, this epoch and last epoch (with `from` and `to`): volume, maker and taker volume, share of the exchange volume, maker share, trades, net PnL, realized, fees, funding, liquidations, PnL per volume (bps) and `rank` by PnL and by volume among every account that traded in that window For the epochs, `blocks` (first and last block with exchange events); for the epoch under way, `rank.volume_to_next` and `rank.next_rank`. |
| `/api/v1/wallets/:key/trades` | `before` = `block:log_index` cursor, `limit` ≤ 500 (10,000 as CSV), `market`, `from` and `to` (unix seconds, a range such as an epoch; up to 100,000 as CSV), `format=csv` | Every position change with the price, size and fee of the fill that settled it, role, realized PnL and remaining size; `next` cursor |
| `/api/v1/compare` | `wallets` = up to ten keys, comma-separated | Profile and performance of each wallet |

## Pipeline and integrity

| Route | Returns |
| --- | --- |
| `/api/v1/health` | Liveness (200). Collector snapshot and status. `alerts` (bot username, chats, messages sent) when the Telegram bot runs. `index.live` (last committed block, commits, errors). `index.backfill` (progress, rate, ETA). `index.topics`: the topic backfill of the protocol balance transfers (`complete`, `pct`, rate, ETA, failed ranges). `index.coverage` intervals, `index.rollups`, `index.decoder_checks`. `feeds` (execution events, WebSocket heads, SSE clients). Memory |
| `/api/v1/integrity` | Event-derived open interest per market and net collateral flow compared with the contract's counters and balance at the collector's block (available once history is complete). `protocol_balance`: the protocol balance rebuilt from launch (`events`) against the contract (`contract`), `difference`, `status` (`match`, `differs`, or `pending` with `scanned_pct` while the topic backfill runs), `revenue` by source, `moves` per transfer kind (amount, count, sign; kinds: `protocol_deposit`, `protocol_withdrawal`, `payout`, `sweep`, `insurance_to_protocol`, `positions_to_protocol`, `protocol_to_market`, `protocol_to_recycle`, `recycle_fee`, `residue_to_protocol`) and `unverified` (off-book liquidations, split applied but the rule not yet seen onchain, their fees; buy-to-liquidate settlements) |
| `/api/v1/integrity/protocol` | `block` (an indexed block) | The same `protocol_balance` comparison at that block, with the contract read at that block from the node or an archive: finds where a difference appears |
| `/api/v1/stream` | Server-sent events: `block`, `trades`, `proposed`, `liquidations`, `protocol`, `backfill` (see `docs/architecture.md`) |

## Risk (contract state)

| Route | Parameters | Returns |
| --- | --- | --- |
| `/api/v1/overview` | | Exchange totals: positions, notional, deposits, equity, liquidatable and bankrupt positions. Market-wide moves, where every market falls or rises by the same amount: notional at risk at 5 % and 10 % in the worse direction (`direction_at_10pct`), shortfall, insurance cover and uncovered shortfall (each market's fund covers only its own market), and `moves` per direction. `liquidity`: the share of each direction's 10 % liquidations that each market's resting depth absorbs, the worse direction (`absorbed_at_10pct_pct`) and the weakest market and side (`complete: false` when a book walk stopped at its level cap) |
| `/api/v1/markets` | | Per-market risk summary |
| `/api/v1/markets/:id` | `limit` | Ladder (per shock: longs at a fall and shorts at a rise, each with its insurance cover, and the worse direction), liquidation map, liquidity (depth bands, absorption, `cost_to_trade` for $1K, $10K and $100K; `book_stale` when the last walk is too old), estimated ADL order, health distribution, concentration by side, top positions, funding and liquidation history |
| `/api/v1/markets/:id/positions` | `side`, `sort`, `limit`, `format=csv` | Every open position with entry, mark notional, deposit, PnL, equity, maintenance margin, health, liquidation and bankruptcy prices and distances, leverage |
| `/api/v1/markets/:id/ladder` | | Liquidation ladder and map |
| `/api/v1/markets/:id/stress` | `move_pct` (signed, e.g. `-10`) | Positions liquidated at that move, notional and share of the hit side's open interest, shortfall, insurance cover, book depth and absorption, largest positions hit |
| `/api/v1/markets/:id/liq-levels` | | Where open positions would be liquidated: 0.5 % price bands within 30 % of the mark with long and short notional, the number of positions and the largest one's account and address |
| `/api/v1/markets/:id/entries` | | Open positions by entry price: bins over the middle 80% of entry notional plus the mark (edge bins open-ended, flagged `edge`), long and short notional and counts per bin; each side's size-weighted average entry, positions in profit and uPnL |
| `/api/v1/markets/:id/flow` | `window`, `bucket` | Open interest opened and closed per bucket, longs and shorts, from position events (opens and adds; reductions, closes, flips and liquidations); window `totals` |
| `/api/v1/markets/:id/book` | | Resting depth walked from the contract, per level and per band |
| `/api/v1/markets/:id/funding` | `limit` | Current and next funding, history of funding events |
| `/api/v1/series` | `hours` ≤ 168, `market` | Sampled risk totals over time (the buffer holds about 25 h: 1,500 samples, one every 200 blocks) |
| `/api/v1/validation` | | Reconciliation, independent verification, PnL agreement and the integrity check |
| `/api/v1/events` | | Recent parameter changes and unwinds |
| `/api/v1/reference` | | Perpl public API figures next to the contract's (only with `REFERENCE_ENABLED=1`) |
| `/api/v1/traders/summary` | `window` (also `this_epoch`, `last_epoch`) | Traders in the window, how many are profitable after fees (count and share), their total net PnL, the exchange volume (each fill counted once), and the median PnL per volume (bps) |
| `/api/v1/traders/moves` | `window` = `7d`, `30d` (default), `all`; `min` USD (default 1000); `limit` ≤ 500 | Latest position changes (last 7 days, maker and taker) of the top 50 accounts by net PnL in the window, market makers and high-frequency accounts left out; each row carries the leader's rank and net PnL; `leaders`, `excluded` |
| `/api/v1/cohorts` | | Open positions now grouped into cohorts by account size (total open notional: whales ≥ $100K, dolphins, fish, shrimp < $1K) and by track record (net PnL over indexed history), with long/short notional, accounts net long/short, unrealized PnL and the largest wallets of each |
| `/api/v1/landscape` | | Market-share context: open interest of perp venues (category Derivatives; front-ends and prediction markets excluded) from DefiLlama's public overview, Perpl's rank and share overall and on Monad (cached 10 min; external data, never used for Plumb's own metrics; off with `LANDSCAPE_ENABLED=0`) |

## Examples

```bash
curl -s localhost:8787/api/v1/protocol?window=7d | jq '.headline.volume'
# → { "value": "<USD>", "prev": "<USD, previous 7 days>", "change_pct": <number> }

curl -s 'localhost:8787/api/v1/leaderboard?window=30d&by=pnl&limit=3' | jq '.rows[] | {rank, address, pnl, volume}'

curl -s localhost:8787/api/v1/wallets/0xc8d79f44912a9f55c6faf819283efcea9661d1dc/periods | jq '.periods[] | {window, net_pnl, rank}'
# a wallet's volume in the last completed epoch
curl -s localhost:8787/api/v1/wallets/0xc8d79f44912a9f55c6faf819283efcea9661d1dc/periods | jq '.periods[] | select(.window == "last_epoch") | {from, to, volume, maker_share_pct}'

curl -s 'localhost:8787/api/v1/markets/1/stress?move_pct=-10' | jq '{liquidated, shortfall, liquidity}'

curl -N localhost:8787/api/v1/stream   # event: block / trades / protocol …
```
