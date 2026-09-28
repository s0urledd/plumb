# Submission: Monad Metropolis hackathon

- **Entry:** one project (the rules allow one per participant, §2.5) in
  track 01, Onchain Finance & Trading, entered for Perpl's "Best Analytics /
  Risk Tool" bounty: the dashboard, the API and the Telegram alerts (this
  document). A trading bot for "Best use of Perpl's API" is planned, not
  built ([bot.md](bot.md)).
- **Submissions:** open 2 October 2026 and close 14 October 2026, 06:59
  GMT+3 (13 October, 11:59 PM ET).
- **Required (rules §4.1, §9):** a public repository with source, README,
  open source licence, attribution and a commit history covering the build
  window; a demo video of at most 3 minutes; how the project uses Monad, with
  contract addresses or transaction hashes; architecture, stack and setup
  documentation; and disclosure of AI coding tools in the README. This
  repository started on 12 September 2026.
- **Sponsor bounty scoring (§5.2):** adherence to the bounty requirements
  40 %, technical implementation 30 %, Monad integration 20 %, innovation
  10 %.

## The brief, point by point

Judging criteria:
- a fast, modern, dark-mode UI;
- real-time data;
- a seamless switch between the protocol view and a wallet;
- signal over clutter.

### Protocol view

| Brief | Where |
| --- | --- |
| Volume, open interest, TVL, fees / revenue, active users over 24h / 7d / 30d / all time | Overview KPIs with the window switch, each compared with the previous period (open interest and TVL: change within the window) and with a sparkline (`/api/v1/protocol`) |
| Time-series charts with timeframes | Volume by market (per period or cumulative), open interest, TVL, net deposits, active traders, fees, liquidations; hourly, 4-hourly or daily by window; CSV and PNG download (`/api/v1/protocol/series`) |
| Deposit / withdrawal flows | Net deposits chart; latest deposits and withdrawals; per-wallet flows tab (`/api/v1/flows`) |
| Per-market breakdown, long / short skew | Markets table and market pages. Perpl's long and short open interest are equal by construction, so skew is shown as the share of positions per side, average leverage per side and taker buy share |
| Liquidations | Liquidations page, liquidations chart by market, latest liquidations on the overview, liquidation ladder per market |
| Funding | Funding per 8 h and APR in every market row; a markets × time funding map on the Markets page; funding history and the next funding block on each market page |
| Market share (optional) | Overview "Market share": Perpl's open interest among perp venues and within Monad, from DefiLlama's open-interest overview (its volume overview became paid), labelled as external and kept out of Plumb's own figures (`/api/v1/landscape`) |

### Wallet view

| Brief | Where |
| --- | --- |
| Address search → full profile | Header search (`/`): address, prefix or account ID |
| Open positions: size, entry, leverage, unrealized PnL, liquidation price | Wallet page, from contract state at the latest finalized block |
| Trade history and realized PnL | Trade history tab with fill prices, role and realized PnL; CSV; round trips tab |
| Win rate, profit factor, max drawdown, streaks, hold time, best / worst markets | Performance panel and KPI strip |
| Save / watch / compare wallets | Star on any trader; watchlist on the Alerts page, with Telegram alerts per wallet; Compare up to five wallets with overlaid PnL curves, opened from a wallet page or the watchlist |
| Portfolio and margin overview | Account value, free and locked balance, margin usage, leverage, closest liquidation |
| Behavioural insights (optional) | Behaviour panel: rule-based notes and a weekday × hour activity map |

### Beyond the brief

- **Rank of any wallet** by PnL and by volume among the accounts that traded
  in the window, for 24h,
  7d, 30d and all time.
- **Trade actions** (open, add, reduce, close, flip, liquidated) on every
  tape, with a size filter.
- **Risk measured from the contract:**
  - notional at risk and bad debt for a market-wide move, with each market's
    insurance cover;
  - liquidation ladder per market;
  - order-book absorption and the cost of a market order, walked from the
    on-chain book;
  - stress test;
  - in the API: liquidation map and an estimated auto-deleveraging order.
- **PnL as the contract settles it:** funding realized at position
  increases and liquidation fees are counted, which event PnL alone misses.
- **Integrity checks:**
  - open interest and TVL rebuilt from every event since launch are
    compared with the contract's own counters;
  - the decoder's linking counters and the collector's reconciliation are
    on the status page.
- **Telegram alerts** (@PlumbPerplBot): watch a wallet for every position
  change and a warning before liquidation at levels the user picks; see its
  positions and distance to liquidation on demand; large liquidations,
  large trades and funding flips. One tap from any wallet page.
- **Straight from Monad:**
  - execution events via Monode: proposed-block trades on the tape within
    milliseconds, finalized data about a second after the block;
  - no dependency on Perpl's API or any third-party indexer.

## Demo (about three minutes)

1. **Header.** Point out the live pill: finalized block number and age. The
   indexing banner goes away once history is complete.
2. **Overview, 24h:**
   - read the KPI strip (volume, open interest, TVL, fees, traders,
     liquidations) with the change on the previous day;
   - toggle a market in the volume chart and switch to cumulative;
   - hover a chart and download it as CSV;
   - show the live tape with trade actions and the size filter;
   - switch the window to 30D and All.
3. **Markets.** Sort by open interest and read the skew bars. Scroll to the
   funding map and hover a cell. Open BTC to show candles, positioning, the
   funding history with its countdown, and the liquidation ladder.
4. **Traders.** Top PnL for 7D, then Top losses. Star a wallet.
5. **Wallet.** Open the top trader:
   - positions with liquidation prices and the By period table with ranks;
   - the PnL curve and the performance panel;
   - the behaviour notes and the trade history, exported as CSV.

   Tap **Alerts**: Telegram opens with the wallet watched; show
   **My positions** and a near-liquidation warning.
6. **Risk.** Drag the stress slider to −10 % on BTC: positions hit, bad debt,
   insurance and book cover.
7. **Status page:**
   - the pipeline (live ingest, backfill, rollups);
   - the integrity check against the contract;
   - the decoder's counters.
8. **Close.** Every number comes from a Monad node: events since launch and
   contract state, both at finalized blocks, and both cross-checked.

## Checklist

- [x] Deploy on the Huginn RPC host with `docker compose` behind TLS
      (https://plumb.huginn.tech).
- [x] Enable the execution event ring and the `exec-events` profile.
- [x] Wait for the backfill to complete, then confirm on the status page
      that the integrity check passes.
- [x] Refresh the screenshots in `docs/images/` from the deployment.
- [ ] Record the demo (at most 3 minutes) while the dashboard is live, so
      the block number advances; link it in the README.
- [x] Make the repository public.
- [x] Link the repository in the project profile.
- [x] Licence file, attribution and AI disclosure in the README.
- [x] Telegram alerts live (@PlumbPerplBot).
- [ ] Project profile: name "Plumb", one-line description and description.

## Claims and their evidence

| Claim | Evidence |
| --- | --- |
| Every figure comes from Monad chain data | Ingest and collector read only the node and archive RPCs; `src/reference.js` (Perpl API) is off by default and used only for comparison |
| Windows are exact sums, and partial windows say so | `meta.coverage` on every windowed response; `docs/methodology.md` |
| Trade prices, sizes and fees come from the settling fills | Full history: 33,557,868 / 33,557,868 position events linked; 18,630,950 / 18,630,950 fee splits equal |
| Event history reproduces the contract | 67 million events since launch give open interest equal to the contract for all 11 markets, and TVL equal to the micro-dollar (`docs/evidence/integrity-2026-09-23.json`, live at `/api/v1/integrity`) |
| Live positions match the contract | Reconciliation every poll; independent rescan hourly (`/api/v1/validation`) |
| PnL and funding formulas match the contract | `docs/validation-gate.md` (557 / 557, 208 / 208) |
| 24 h volume matches Perpl's own figure | Within 0.001 % on 2026-09-21, 0.035 % on 2026-09-23 and 0.049 % on 2026-09-28 (`docs/methodology.md`) |
| A liquidation's result is the trader's balance change | The trader gets back exactly 80 % of the remaining margin (`accAmountCNS`), e.g. at block 107,162,461; the rest is counted as a fee (`test/decode.test.js`) |
| Fees are not double counted | A builder's share is inside the fill fee and the protocol part on all 1.6 million fills that carry one (checked in ClickHouse, 2026-09-23) |

Claims to avoid:
- exact prediction of liquidation execution prices;
- market share figures as Plumb's own measurement (they are DefiLlama's);
- anything about accounts or periods the status page shows as not yet
  indexed.
