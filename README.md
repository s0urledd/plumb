# Plumb

**Real-time analytics, risk data and alerts for Perpl on Monad.**

Plumb tracks every trade, position and liquidation on
[Perpl](https://perpl.xyz), the onchain perpetuals exchange on Monad, as it
happens: a trade shows on the live tape as soon as its block is proposed,
before it is final, and the finalized figures follow about a second later.
Monad's speed and Perpl's fully onchain order book make that possible. It is
built from raw exchange events and contract state, indexed directly from
Monad, with no third-party indexer or Perpl API in the data path.

**[plumb.huginn.tech](https://plumb.huginn.tech)** · [API](docs/api.md) ·
[Features](docs/features.md) · [Methodology](docs/methodology.md)

[![ci](https://github.com/s0urledd/plumb/actions/workflows/ci.yml/badge.svg)](https://github.com/s0urledd/plumb/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Plumb overview](docs/images/overview.png)

## Features

**Protocol.** Volume, open interest, TVL, fees and revenue, active traders,
flows and liquidations for 24h, 7d, 30d and all time, with time series by
market. A markets table with funding, long/short skew and taker flow, and a
page per market. Live trades appear within a second of their block.

**Wallets and traders.** Search any address for its open positions and
liquidation prices, trade history and realized PnL, win rate, profit factor,
drawdown, streaks, hold times and rank against every other trader.
Leaderboards for any window, and cohorts that show who holds the open
interest, from whales to small accounts and from top winners to the rekt.

**Risk.** Perpl keeps its order book and positions onchain, so risk is
measured, not modelled: notional at risk for a market-wide move, the
liquidation ladder, bad debt against each insurance fund, how much of it the
book can absorb, and a stress test.

**Alerts.** A Telegram bot watches your wallets: every position change,
the live distance to liquidation, and warnings at the levels you choose.
It also sends large liquidations, large trades and funding flips, from the
same events as the dashboard.

The full list is in [docs/features.md](docs/features.md).

![Wallet profile](docs/images/wallet.png)

## Data and accuracy

| | |
| --- | --- |
| Network | Monad mainnet (chain 143) |
| Perpl exchange | [`0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`](https://monadvision.com/address/0x34B6552d57a35a1D042CcAe1951BD1C370112a6F) |
| Collateral (AUSD) | [`0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`](https://monadvision.com/address/0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a) |
| History | from block 54,773,010 (11 February 2026), about 67 million events |

Sources, all Monad RPC:
- exchange events (`eth_getLogs`) over finalized blocks: fills, position
  changes, funding, liquidations, deposits and withdrawals;
- contract state (`eth_call` through Multicall3, at a pinned block): every
  open position, the order book, insurance funds, market parameters;
- the node's execution event stream, through a
  [Monode](https://github.com/monad-developers/monode) sidecar, for trades in
  proposed blocks.

With 0.3 s blocks and the whole order book onchain, the dashboard runs about
a second behind the chain, and its risk figures come from real positions and
real depth.

How we know the numbers are right:
- **The history reproduces the contract.** Open interest rebuilt from every
  event since launch equals the contract's own counters for all 11 markets,
  and net collateral flow equals the exchange balance to the micro-dollar
  ([evidence](docs/evidence/integrity-2026-09-23.json), live at
  `/api/v1/integrity`).
- **Every trade is priced from its fill**, with fees split exactly as the
  contract splits them.
- **Finalized blocks only**, and every window says whether its history is
  complete.
- **24 h volume matches Perpl's own figure** within 0.1 %.

Details in [methodology](docs/methodology.md) and
[architecture](docs/architecture.md).

## API

Everything on the dashboard is available as JSON, tables also as CSV, and a
server-sent event stream pushes blocks, trades and liquidations.

```bash
curl -s 'https://plumb.huginn.tech/api/v1/protocol?window=7d' | jq .headline.volume
curl -s 'https://plumb.huginn.tech/api/v1/leaderboard?window=30d&by=pnl&limit=10'
curl -s  https://plumb.huginn.tech/api/v1/cohorts | jq '.by_size[] | {label, long_share_pct}'
curl -N  https://plumb.huginn.tech/api/v1/stream
# a wallet's positions and how far each is from liquidation
curl -s  https://plumb.huginn.tech/api/v1/wallets/1 | jq '.positions[] | {symbol, side, notional, liquidation_distance_pct}'
```

Amounts are exact decimal strings, and every response carries the block it
was computed at, so scripts and bots can use the data as it is. Reference: [docs/api.md](docs/api.md).

## Architecture

```
  Monad node                                      Plumb (docker compose)
  ----------------------------                    ----------------------------------
  monad-execution
    execution event ring -----> Monode sidecar -->  ingest     events -> ClickHouse
  monad-rpc
    JSON-RPC (eth_getLogs, eth_call) ------------>  collector  contract state, risk
    WebSocket (newHeads) ------------------------>
                                                    ClickHouse events, hourly rollups
                                                    API        JSON, CSV, SSE
                                                    web/       dashboard
```

- **Ingest** follows the finalized head, links every position change to its
  fill, and backfills history from launch.
- **Collector** reads all open positions and the order book at a pinned
  block and computes margin, liquidation prices and stress figures in exact
  integer arithmetic.
- **ClickHouse** stores events and hourly rollups; windows are answered from
  rollups plus raw events at the edges.
- **API** serves the dashboard and everyone else, with per-IP rate limits.

Stack: Node.js 22+, ClickHouse 26.8, plain JavaScript and Apache ECharts on
the front end (no build step), Docker Compose behind nginx. We run it on a
dedicated Monad mainnet node.

## Run it

```bash
cp .env.example .env          # MONAD_RPC_URL, ARCHIVE_RPC_URLS, CLICKHOUSE_PASSWORD
docker compose up -d --build  # app + ClickHouse on 127.0.0.1:8787
docker compose --profile exec-events up -d --build   # optional, with the node's event ring
```

No Monad node? Set both `MONAD_RPC_URL` and `ARCHIVE_RPC_URLS` to
`https://rpc1.monad.xyz`. That public endpoint serves the 1000-block log
ranges, finalized blocks and `eth_call` Plumb needs. It is rate-limited, so the
history takes longer; `BACKFILL_FROM_BLOCK` indexes a shorter stretch.
(`rpc.monad.xyz` caps log ranges at 100 blocks and will not do.)

The live feed starts at once; history since launch is indexed in the
background in one to three hours. The [runbook](docs/runbook.md) covers the
reverse proxy, the event ring and configuration.

```bash
npm ci && npm run check && npm test   # unit tests, no network needed
```

## Roadmap

- **More alerts**: webhooks alongside Telegram, and alerts on a market's
  liquidation ladder.

## Monad Metropolis

Entered in track 01, Onchain Finance & Trading, for Perpl's "Best Analytics /
Risk Tool" bounty. Checklist and demo notes:
[docs/submission.md](docs/submission.md).

## Credits

- ABI subset from Perpl's `perpl-sdk`, MIT, © 2025 Perpl Foundation
  ([abi/README.md](abi/README.md), [licence](abi/LICENSE-perpl-sdk)).
- [viem](https://github.com/wevm/viem) (MIT),
  [Apache ECharts](https://github.com/apache/echarts) (Apache-2.0),
  [Geist](https://github.com/vercel/geist-font) (SIL Open Font License 1.1),
  [ClickHouse](https://github.com/ClickHouse/ClickHouse) (Apache-2.0),
  [Monode](https://github.com/monad-developers/monode) (MIT, built from a
  pinned commit in `deploy/monode`).
- Market-share data from [DefiLlama](https://defillama.com/open-interest).
- Market and venue logos belong to their owners
  ([sources](web/img/markets/README.md)).
- Cohort icons (whale, dolphin, fish, shrimp) by Delapouite from
  [game-icons.net](https://game-icons.net), CC BY 3.0.
- Built with help from Claude Code as a coding assistant for parts of the
  code, tests and docs. Design, infrastructure, data validation and review
  are the team's.

---

Built by [Huginn](https://huginn.tech). Unofficial: not affiliated with
Perpl or the Monad Foundation. [MIT](LICENSE).
