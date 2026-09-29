# Methodology

Version 4 (2026-09-28). Plumb uses two sources, both read at finalized
blocks:

- **History** (volume, fees, flows, liquidations, funding payments, realized
  PnL, wallet trades) is summed from the exchange's own events since its
  deployment, decoded once into ClickHouse (see the second half of this
  document).
- **Current state** (positions, liquidation prices, open interest, TVL,
  insurance) is read from the contract at the collector's latest finalized
  block. The order book is walked separately, every 30 s, at its own block.
  Risk responses carry the block, its hash and freshness; analytics
  responses carry the last indexed block.

Perpl's public API is never an input.

## Units

The contract stores fixed-point integers. Plumb keeps them as BigInt and
converts only for display.

| Suffix | Meaning |
| --- | --- |
| PNS | price × 10^priceDecimals |
| LNS | size × 10^lotDecimals |
| CNS | collateral × 10^collateralDecimals (AUSD, 6) |
| Q16 | entry-price residue, 1/65536 of one PNS unit |
| hdths | margin fraction as leverage × 100 (`2500` ⇒ 25.00 ⇒ 4 % of notional) |
| pct100k | funding rate × 10^5 (`-4` ⇒ −0.00004 per funding interval) |

Effective entry price follows `perpl-sdk` `Position::effective_entry_price`:
long entries are stored rounded up and the residue is subtracted
(`(pricePNS − 1) + residue / 65536`), short entries are stored rounded down
(`pricePNS + residue / 65536`); with a zero residue the stored price is exact.

## Position quantities

- Notional at price P: `N = P × size`.
- Delta PnL: `side × (mark − entry) × size`, rounded toward zero. This matches
  the contract's `getPositionsV2.deltaPnlCNS` exactly (557 / 557 live).
- Premium PnL is the contract's `premiumPnlCNS` (cumulative funding). Its
  change across a funding event equals `−side × payment × size`, where
  `payment = fundingPaymentPNS / 10^(fundingSumScalingExp + priceDecimals)`;
  positive payments flow from longs to shorts (208 / 208 live).
- Equity (fair market value): `FMV = deposit + deltaPnl + premiumPnl`.
- Maintenance margin requirement: `MMR = entry × size ÷ (maintHdths / 100)`,
  using the market's current `getMarginFractions` value.
- Liquidation condition (Perpl docs): `0 < FMV ≤ MMR`; bankrupt when `FMV ≤ 0`.
- Health: `FMV ÷ MMR` in basis points.
- Liquidation price: `P_liq = entry + side × (MMR − deposit − premiumPnl) ÷ size`,
  clamped at zero; `side` is +1 for longs and −1 for shorts.
- Bankruptcy price: `P_bkpt = entry − side × (deposit + premiumPnl) ÷ size`.
- Distance to liquidation: adverse move of the mark, in basis points, that
  reaches `P_liq`; negative means already crossed.
- Leverage: entry notional over deposit; effective leverage: mark notional
  over equity.

Both price formulas come from docs.perpl.xyz/exchange/liquidation and
`perpl-sdk` `src/state/position.rs` (`liquidation_price`, `bankruptcy_price`).
Liquidation prices are reported in micro-PNS and floored. Positions liquidated
on-chain are checked against this classification on every validation run.

## Market aggregates

- **Open interest**: sum of stored sizes per side. Must equal
  `longOpenInterestLNS` / `shortOpenInterestLNS` at the same block; any
  difference marks the state stale. Both sides are equal on a matched book
  (checked every poll), so open interest counts one side, and exposure is
  analysed per side rather than as a long/short ratio.
- **Liquidation ladder**: for each adverse move `k` in
  {0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50} %, the count and mark notional of
  positions whose liquidation distance is ≤ `k`, per side. **Shortfall** at
  `k` is the sum of `max(0, −FMV(P_k))` over positions whose bankruptcy price
  is crossed at the shocked price `P_k`; it is the bad debt that would arise
  if no liquidation executed before the move. Longs are hit by a fall and
  shorts by a rise, never both at once, so each side keeps its own figures
  and a row's headline is its worse direction. **Insurance coverage** divides
  the market's `insuranceBalanceCNS` by the shortfall of one direction.
- **Liquidation map**: mark notional of positions binned by the signed
  distance of their liquidation price from the mark, 50 bps bins over ±30 %;
  positions beyond the range are reported as tails.
- **Health distribution**: notional and count per health bucket
  (<100 %, 100–125, 125–150, 150–200, 200–300, 300–500, >500 %).
- **Concentration**: top-1/5/10 shares of mark notional and HHI (sum of
  squared shares, 0–10000) for all positions and per side.
- **Insurance**: balance relative to total notional and to total maintenance
  margin; liquidation proceeds split from `getLiquidationInfo`.
- **Funding**: `fundingRatePct100k / 10^5` per funding interval
  (`getFundingInterval`, 8,571 blocks). The 8 h and annual (365-day)
  equivalents scale it by the interval's measured duration: block time from
  block timestamps over 1,000 blocks at start, then re-measured every 3,000
  blocks. Next funding block: `block − block mod interval + interval`.
  History from `FundingEventCompleted` (rate, funding price, payment per unit,
  cumulative sum). See [Funding](#funding) for the interval.
- **On-chain liquidity**: the resting book is walked from the best bid and best ask through `getNextPriceBelowWithOrders` / `getNextPriceAboveWithOrders`, reading `getVolumeAtBookPrice` at each level, at its own pinned block (the collector's block when the walk starts; `book_block` and `age_blocks` give its age), every `BOOK_REFRESH_MS` (30 s), up to `BOOK_LEVELS` levels per side within `BOOK_RANGE_BPS` of the mark (defaults 40 and 15 %). A book older than three walks is treated as unavailable. Only the firm `bids` / `asks` counters count as depth; the `expBids` / `expAsks` counters were observed to hold expired orders awaiting clearing and are reported separately. **Depth within k %** is the notional of levels within k % of the mark on one side. **Cover** at move k is `depth within k % ÷ liquidation notional within k %` on the side the liquidations would trade into (long liquidations sell into bids, short liquidations buy from asks). A cover below 100 % means resting orders cannot absorb the forced flow without moving through the whole measured book. Exchange-wide, each market's depth absorbs at most its own demand: the figure is `Σ min(depth, demand) ÷ Σ demand` for a market-wide fall (longs into bids) and for a rise (shorts into asks), reported for the worse direction together with the weakest market and side.
- **Cost of a market order**: the volume-weighted fill price of a $1K, $10K or $100K market buy (walking the asks up) or sell (walking the bids down) through the firm depth read from the contract, against the mid, in basis points; half the spread is included. When the levels read hold less than the order, the cost is reported as beyond the book instead of a number. The markets table shows the mean of buying and selling $10K, and the spread.
- **Stress test**: for any signed move the same ladder arithmetic is evaluated at that single shock, returning the positions hit, their share of that side's open interest, shortfall, insurance cover and depth in range.
- **Auto-deleveraging queue (estimate)**: per side, profitable positions ranked by unrealised return on deposit (`pnl ÷ deposit`). Perpl documents only "a sorted list of opposing position IDs (most profitable first)" and that selection is performed off-chain, so the ranking metric is our assumption.
- **Series**: every `SERIES_EVERY_BLOCKS` blocks the collector samples exchange totals and per-market notional, exposure at 10 %, shortfall, insurance, funding rate and 2 % depth into a bounded ring buffer persisted with the checkpoint.
- **Basis**: `(mark − oracle) / oracle`. Perpl clamps the mark to within ±0.25 % of the spot index, so this shows where the mark sits inside that clamp, not a free perpetual premium.
- **Exchange totals** sum the per-market values. Move-based totals (notional at risk, shortfall, book absorption) take one market-wide direction at a time: every market falls (liquidating longs) or rises (liquidating shorts) by the same amount, and the headline reports the worse direction. Each market's insurance fund covers only its own market's shortfall, so exchange-wide cover is `Σ min(insurance, shortfall) ÷ Σ shortfall`.

## Validation status per metric

| Metric | Status | Evidence |
| --- | --- | --- |
| Open interest | validated | Exact per side at every poll; independent account-bitmap rescan agrees |
| Delta PnL | validated | 557 / 557 positions equal the contract (truncation) |
| Premium PnL | validated | Contract value; funding formula 208 / 208 across live events |
| Funding history | validated | `getFundingSumAtBlock` equals emitted sums where state was available |
| Liquidation classification | validated on 1 sample | The one on-chain liquidation with retained state in the sampled windows was classified liquidatable (health 99.08 %) |
| Liquidation price | formula | Documentation and SDK; direct contract diagnostics (`CantLiquidatePosAboveMMR`) not observed in the sampled windows |
| Ladder, map, shortfall, coverage | derived | Deterministic functions of the validated inputs above |
| Concentration, health | derived | Deterministic |
| Insurance balances | on-chain | `getPerpetualInfoV2` |
| Resting depth | on-chain | Walked level by level; walk cost 40 requests for 11 markets in 2.4 s on the public RPC. Depth past a walk that hit its level cap is a lower bound (`complete: false`, shown as "≥") |
| Liquidity cover, stress test | derived | Deterministic functions of validated inputs |
| ADL queue | estimate | Perpl documents "most profitable first" without the metric; selection is off-chain |
| Trade price, size and fee from linked fills | validated | Full history: 33,557,868 / 33,557,868 position events linked, and fee split equal to the fill fee on 18,630,950 / 18,630,950 building fills (2026-09-23) |
| Volume | validated | 24 h maker-fill volume within 0.001 % (2026-09-21) and 0.035 % (2026-09-23) of Perpl's venue figure |
| Protocol revenue by source | validated | Revenue plus the balance moves that are not revenue reproduce `protocolBalanceCNS` and every market's `insuranceBalanceCNS` with zero residual: 16 block ranges and 24 hourly checks, 25–28 Sep 2026 (`docs/evidence/protocol-revenue-2026-09-28.json`). Bankrupt, partial and off-book liquidations, deleverages and buy-to-liquidate were not observed |
| Open interest and TVL from events | validated | Summed from launch, both equal the contract at the same block: all 11 markets exact, TVL to the micro-dollar (2026-09-23, `docs/evidence/integrity-2026-09-23.json`) |

Not modelled: individual resting orders (only aggregate depth per price
level), cross-margin (the venue is isolated-margin), funding accrued between
funding events, dynamic initial margin for large sizes (reported as
`dynamic_max_leverage` only). Wallet flows count deposits and withdrawals
only; internal transfers such as `TransferAccountToProtocol`,
`TransferProtocolToAccount`, `AccountLiquidationCredit` and fee recycling are
not attributed to wallets (they do not change the exchange's balance, so the
TVL check is unaffected).

## History metrics from exchange events

Every figure below is a sum over decoded exchange events for the requested
window. Each metric has one definition (`src/aggregates.js`), used both for
hourly rollups and for raw rows, so a window gives the same answer however it
is assembled. All amounts stay in contract units (integers) until they are
formatted for display.

**Trade price, size and fee.** A position event does not carry the price it
traded at (`PositionIncreased.pricePNS` is the blended entry price) and
`PositionClosed` carries no size. Every position event is immediately
followed in its transaction by the fill that settled it: a maker fill for the
same account and market, or the aggressor's taker fill. The decoder links
them and takes price, size and fee from the fill. Over the full history, all
33,557,868 position events linked. A liquidation executed on the book reports
its taker fill before `PositionLiquidated` and is linked the same way; all
3,341 liquidations to date executed on the book. `PositionInverted` carries
the new side.

| Metric | Definition |
| --- | --- |
| Volume | Sum of maker-fill notional (`MakerOrderFilled(V2)`, price × size), so each match counts once. Its size equals the taker side exactly; notional agrees to rounding (about $50 over $5.27 billion). |
| Trades | On the dashboard, matches between a maker and a taker (maker fills), each counted once. The API's `trades` counts position changes of both counterparties (open, increase, decrease, close, invert); per account, liquidations settled as taker also count. |
| Fees | Sum of `feeCNS` on maker and taker fills, gross: maker rebates and referral shares are paid outside fills and are not deducted. Up to contract version 1.7.4 (release v1.1.7.4), only fills that build a position (open, increase, invert) are charged; from 1.7.5 (block 107,355,313, 2026-09-23) decreases and closes are charged too. The split of a building fill into insurance fund (`insFeeCNS`) and protocol (`protFeeCNS`) comes from the position event, and must equal the fill fee; this is checked on every building fill at ingest. Decrease and close events carry no split: it is derived from their fill with the same rule (see [Protocol revenue](#protocol-revenue)), so protocol + insurance fees equal fees. A builder's share (`builderFeeCNS`) is included in the fill fee and in the protocol part, never added on top. Take rate is fees ÷ volume. An account's fees also include its liquidation fees (below). |
| Active traders | Distinct accounts with at least one trade in the window (each account once per window or chart bucket). |
| New accounts | `AccountCreated` events. |
| Deposits, withdrawals, net flow | `CollateralDeposit` and `CollateralWithdrawal` amounts; net flow is deposits − withdrawals. |
| Liquidations | `PositionLiquidated`: count, and notional as liquidated size × liquidation price. `PositionDeleveraged(V2)` is auto-deleveraging, or a force close at the mark price when its `forceClose` flag is set; all 11 to date are force closes. |
| Realized PnL | `deltaPnlCNS + fundingCNS` on decrease, close, invert, liquidation and deleverage events, plus `premiumPnlSettledCNS` on increases (the contract realizes accrued funding whenever the lot changes), before fees. On a liquidation the event's `deltaPnlCNS` is the would-be PnL at the exit price: the trader gets back only part of the remaining margin (`accAmountCNS`, 80 % by default) and the rest is the account's **liquidation fee**; a loss beyond the removed deposit falls on the insurance fund and is not counted against the trader. **Net PnL** = realized − fees (fill fees and liquidation fees). |
| Taker buy share | Taker notional of position changes that buy (opening, adding to or flipping into a long; reducing or closing a short) ÷ all taker notional. Long and short open interest are equal on a matched book, so this is where directional pressure shows. |
| Price, OHLC, change | Fill prices per market and bucket. Change is the last fill price of the window against the first. |
| Open interest over time | Running sum since launch of each market's open-interest change (open and increase add, decrease, close, liquidation and deleverage remove; invert moves size across sides), priced at the last fill of each bucket. It is drawn only when history is contiguous from launch. The headline figure is the contract's counter at the mark. |
| TVL over time | Running sum since launch of user and protocol deposits minus withdrawals. Trading moves collateral between accounts inside the contract, so only transfers change the contract's balance. |
| Window comparison | A window is `[head − length, head]`. `prev` is the preceding window of the same length; `change_pct` = (value − prev) ÷ prev. All-time starts at the first indexed block. |
| Coverage | Every windowed response states whether indexed history covers the whole window. A partial window is labelled, never silently short. |

**Integrity.** Summing every event since launch must reproduce the
contract:
- per market, the event-derived open interest must equal
  `longOpenInterestLNS` and `shortOpenInterestLNS`;
- the net flow must equal the exchange's collateral balance at the same
  block.

`GET /api/v1/integrity` and the status page run this check. On 2026-09-23 at
block 107,279,223, over 67,168,371 events from block 54,773,010 onwards:
- open interest matched the contract exactly for all 11 markets on both
  sides;
- the net flow matched the balance to the micro-dollar ($3,942,293.243869);
- no position event was left unlinked (0 of 33,557,868);
- no fee split differed from its fill (0 of 18,630,950);
- the table held no duplicate rows.

Evidence: `docs/evidence/integrity-2026-09-23.json`.

**Corrections in version 3.** Re-reading the chain over the full history
(2026-09-23) sized what the previous decoder missed: the funding settled at
151,626 position increases ($106,859 moved, $13,234 net to traders), the
liquidation fees of all 3,341 liquidations ($84,765), and builder shares
counted twice in wallet fees ($20,345). Together they change the realized
PnL of 2,878 accounts, by up to $7,628 for one account
(`docs/evidence/pnl-corrections-2026-09-23.json`). Neither open interest nor
TVL depends on them, so the integrity checks above are unchanged.

### Protocol revenue

The exchange splits every charged fill fee, and the margin a liquidation
leaves, between the market's insurance fund and the protocol. Plumb reports
both shares by source (`src/revenue.js`, `src/aggregates.js`):

| Source | Split |
| --- | --- |
| Opening fees (open, increase, invert) | The split on the position event: `protFeeCNS` to the protocol, `insFeeCNS` to the insurance fund. |
| Reducing fees (decrease, close) | Charged from contract version 1.7.5; before, their fee was 0. The events carry no split, so the linked fill gives it: insurance = ⌈(`feeCNS` − `builderFeeCNS`) × `insAmtPer100K` ÷ 100,000⌉, protocol = `feeCNS` − insurance. Opening events follow the same rule. |
| Liquidations, full or partial | X = `deltaPnlCNS` + `fundingCNS` − `posAmountCNS`, the margin left (`posAmountCNS` is minus the deposit released). If X > 0, the trader gets ⌊X × `liqUserAmtPer100K` ÷ 100,000⌋ (the event's `accAmountCNS`), the insurance fund ⌊X × `liqInsAmtPer100K` ÷ 100,000⌋ and the protocol the rest, rounding dust included. If X ≤ 0, Plumb counts nothing for either (not verified). The liquidated position's own fill carries no fee. |

A builder's fee stays inside the protocol's share of the fee: it is owed to
the builder and reported on its own as `builder_fees`. Protocol revenue is
the protocol's share of opening fees, reducing fees and liquidations.

**Rates.** A market's `insAmtPer100K` is set by `FeeParamsUpdated`, its
liquidation rates by `LiquidationParamsUpdated` (`insAmtPer100K`,
`userAmtPer100K`), and all three by the `ContractAdded` event that lists it;
each applies from its own block. The protocol gets the rest of X, so
`liqAmtPer100K` is not read: it equals the protocol's share only while the
three rates add up to 100,000. On 2026-09-28 all 11 markets used 15,000
(15 %) and 10,000 / 80,000 / 10,000 (insurance / trader / protocol).
`FeeParamsUpdated` and the rates a market is added with were not stored for
the history indexed before 2026-09-29; the topic backfill (below) reads them
over the whole history, and until it has, the fee split uses 15,000 where no
change is indexed. Reducing fills were free before 1.7.5, so this matters
from 23 September 15:20 UTC; 15,000 was checked from 25 September 12:03 UTC.
Liquidations before a market's first indexed `LiquidationParamsUpdated` use
10,000 / 80,000, verified from 25 September only.

**Every liquidation follows the protocol's rules** (the Exchange contract's
notes on `liquidation` and `buyLiquidations`): the margin left splits
between the trader, the insurance fund and the protocol by the market's rates,
and the protocol keeps the rest.
- On the book, when the trader's share is paid (`accAmountCNS` = ⌊X × user⌋,
  the stored fee is the rest of X): the split above, full or partial.
- On the book, when the trader's share is added to the position left open
  (`accAmountCNS` = 0): the event's X is the margin less that share, so the
  margin is X ÷ (1 − user) and the insurance fund's share is taken of it; the
  protocol gets the rest of X.
- Off the book (buy to liquidate): the buyer takes a share as well, by the
  buy-to-liquidate rates (`ContractAdded`, `BuyToLiquidateParamsUpdated`;
  25 % each to the insurance fund, the trader and the buyer unless indexed);
  the protocol gets the rest.

The last two have not happened on Perpl yet; they are counted like the rest
and listed under `unverified` so the balance check shows them if they do.

**Partial liquidations** that pay the trader follow the same split. Example, block 97,375,221:
perp 20, account 1767, 74,906 lots liquidated on the book and 9,628 left;
X = $6,723.071842, `accAmountCNS` = ⌊0.8 X⌋ exactly, and the protocol
balance rose by X − ⌊0.8 X⌋ − ⌊0.1 X⌋ = $672.307185 (plus the block's
opening fees). The 98 partial liquidations in the history each moved the
protocol balance by their protocol share this way (found by comparing the
rebuilt balance with the contract block by block, see Protocol balance).

**Not revenue.** `TransferProtocolToAccount` (payouts to accounts, such as
$7,259.74 to 272 accounts on 28 September), `TransferAccountToProtocol`
(such as $152,663.75 from account 777 on 25 September), `ResidueTransferred`
(a market's position-balance residue, see Protocol balance),
`ProtocolBalanceWithdraw` and `ProtocolBalanceDeposit` move the protocol
balance but are never counted as revenue.

**Verification.** Revenue by these rules, plus the balance moves above,
reproduced the change of the contract's `protocolBalanceCNS` and of every
market's `insuranceBalanceCNS` with zero residual on 16 block ranges from 25
to 28 September (among them liquidations, a payout batch, sweeps and a
protocol withdrawal) and on 24 consecutive hours from 27 September 12:00
UTC. In those 24 hours the protocol earned $1,465.17 from opening fees,
$1,995.73 from reducing fees and $202.46 from 16 liquidations; builder fees
inside the protocol share were $105.65
(`docs/evidence/protocol-revenue-2026-09-28.json`; block ranges, so a window
by block time can differ by the trades of its edge seconds).

**Not seen on chain yet**: bankrupt liquidations (X ≤ 0) leave nothing to
split (on the book they cannot happen: a fill past the bankruptcy price
reverts); liquidations off the book and those that add the trader's share to
the position are counted by the protocol's rules above and listed as
`unsplit_liquidations`; deleverages and buy-to-liquidate settlements bring
the protocol nothing (the SDK treats liquidation, deleverage, force close and
unwind as uncharged). What the payouts are for is not stated on-chain; the
docs say rebates and referral shares are paid off-chain every two weeks.

**History and rollups.** The split is derived per stored row whenever
windows and hourly rollups are summed, so no event was read from the chain
again. Rollup version 3 added the reducing-fee split and the liquidation
shares as new columns (`ADD COLUMN IF NOT EXISTS … DEFAULT 0`); version 4
splits every book liquidation that paid the trader, partial ones included;
version 5 applies the protocol's rules to every liquidation. At
start, the hours of each UTC day rolled at the previous version with no liquidation are
carried over unchanged, and every other day is rolled again from the stored
events (whole days, so the hours left to roll form few ranges); both steps
are safe to repeat. A database at an older version rolls everything again. A rate change indexed
after hours it applies to (the backfill runs newest first) marks those
hours to roll again before the change is stored.

### Protocol balance

The contract keeps one protocol balance (`getExchangeInfo` →
`protocolBalanceCNS`). Plumb rebuilds it from launch, event by event, and
compares it with the contract at the snapshot block, as it does for open
interest and TVL (`/api/v1/integrity` → `protocol_balance`, and the status
page).

| Movement | Event | Sign | Revenue |
| --- | --- | --- | --- |
| Protocol share of fees and liquidations | see Protocol revenue | + | yes |
| Protocol deposit | `ProtocolBalanceDeposit` | + | no |
| Protocol withdrawal | `ProtocolBalanceWithdraw` | − | no |
| Payout to an account | `TransferProtocolToAccount` (kind `payout`) | − | no |
| Transfer from an account | `TransferAccountToProtocol` (kind `sweep`) | + | no |
| From a market's insurance fund | `TransferPerpInsToProtocol` (`insurance_to_protocol`) | + | no |
| From a market's position balance | `TransferPerpPosToProtocol` (`positions_to_protocol`) | + | no |
| To a market (insurance fund or positions) | `TransferProtocolToPerp` (`protocol_to_market`) | − | no |
| To the recycle balance | `TransferProtocolToRecycleBal` (`protocol_to_recycle`) | − | no |
| Recycle fee | `RecycleFeeToProtocol` (`recycle_fee`) | + | no |
| Residue from a market's position balance | `ResidueTransferred` (`residue_to_protocol`) | + | no |

Builder fees stay inside the balance. Funding, collateral deposits and
withdrawals and position collateral changes never touch it. The first four
rows and the revenue shares were checked with zero residual (Protocol
revenue, Verification); the recycle fee and the residue were found and
checked by the block-by-block comparison below. `TransferPerpInsToProtocol`,
`TransferPerpPosToProtocol` and `TransferProtocolToRecycleBal` never
occurred, so their effect is the one their names and arguments state, not
verified.

**Residue transfers.** At a contract upgrade the exchange can move what is
left in a market's position balance to the protocol. At the upgrade of
1 June 2026 18:22 UTC (block 78,474,467) four `ResidueTransferred` events
(markets 1, 10, 20 and 30: $1,774.906687, $19,850.782420, $955.880703 and
$10,712.028672) added exactly the protocol balance's rise of $33,293.598482,
while the exchange balance did not change.

**Topic backfill.** The transfers (and `FeeParamsUpdated` and
`ContractAdded`) were not read for the history indexed before 29 September
2026. The set is named (`protocol-v2` since `ResidueTransferred` was added):
a new name starts its coverage empty, so the whole history is read again
and rows already stored are skipped. A separate backfill reads only these topics over every block range
indexed before, newest first: the node while it still has the range, then
the archive endpoints, paced (`TOPIC_BACKFILL_RPS`). It records its own
coverage (`topic_chunks`); every range the ingest reads from now on counts
too, since the ingest reads these topics as well. A row already stored is
never inserted twice. Until the scan is complete the check reports
`pending` with the share scanned.

**Reading the check.** `match` means every movement above, summed from
launch, equals the contract to the micro-dollar. `differs` shows the
difference with the full breakdown. `/api/v1/integrity/protocol?block=N`
gives the same comparison at any indexed block (the contract read at that
block from the node or an archive), so the block where a difference
appears can be found by bisection; that is how the residue transfers and
the partial-liquidation shares were found (before them, the rebuilt balance
was $37,524.01 below the contract). The remaining unverified cases are
liquidation shares before the rates were known (liquidations before a
market's first indexed rate change use 10,000 / 80,000), the liquidations
listed under `unverified` (off the book, or the trader's share added to the
position) and buy-to-liquidate settlements, and the three transfers never
observed.

### Funding

The current rate is the contract's `fundingRatePct100k` per funding interval.
Perpl describes funding as "approximately once per hour": every 8,571 blocks,
assuming 0.42 s per block. At the measured 0.30 s blocks of September 2026 an
interval lasts about 43 minutes (before 23 July 2026, at about 0.40 s, about
57 minutes). The 8 h and annual (365-day) equivalents scale the rate by the
interval's measured duration, so they state what a position actually pays
per 8 hours of clock time; they are about 40 % higher than a nominal
"hourly rate × 8". The funding map annualises each bucket with the interval
length of its own time. History comes from `FundingEventCompleted`: rate,
funding price, payment per unit and cumulative sum per market.

### Wallet analytics

- **Round trips.** Perpl margins each market in isolation, so an account has
  at most one position per market. A trip opens with an open and grows with
  increases. It realizes PnL on decreases and ends with a close, a full
  liquidation or a full deleverage. A flip ends the trip and starts one on
  the other side. A trip's net result is realized PnL (funding included)
  minus fees: the funding settled at increases counts, and so does a
  liquidation fee. A trip opened before the indexed history is marked
  incomplete: it has no return and is left out of hold-time statistics.
- **Performance** over closed trips:
  - win rate = winning trips ÷ closed trips;
  - profit factor = gross profit ÷ gross loss;
  - expectancy = mean net per trip;
  - max drawdown = largest peak-to-trough fall of cumulative net PnL in trip
    order, with its dates;
  - streaks count consecutive wins or losses;
  - hold time = close time − open time (mean, median, winners, losers);
  - best and worst market by net PnL.

  For very active wallets, trips are built from the latest 150,000 events
  and the response says so. Totals, per-market sums and period ranks always
  use full history.
- **Periods and ranks.** For the last 24 h, 7 d, 30 d and all time: volume,
  trades, net PnL, PnL per volume (bps), and the wallet's rank by net PnL and
  by volume. The rank is 1 + the number of accounts with a strictly higher
  value, among accounts with at least one trade in the same window. The rank
  tables are recomputed every minute.
- **Behaviour** notes are rule-based sentences over these numbers (style,
  discipline, streaks, leverage, timing); no model is involved, so every
  sentence traces to a figure on the page.
- **Leaderboard** ranks the accounts that traded in the window by net PnL,
  losses, volume, realized PnL, fees, trades or liquidated notional, and the
  accounts with deposits or withdrawals by flows. Ties share a rank, as on
  wallet pages. PnL per volume is shown next to PnL, so large PnL from large
  volume can be told apart from an edge.

### Cross-checks against the venue

Perpl's public API is never an input. It is only used to check the volume
rule against the venue's own reported 24 h volume:

| Date | Pipeline | Plumb | Perpl | Total gap | Largest market gap |
| --- | --- | --- | --- | --- | --- |
| 2026-09-21 | In-memory event index | $41,345,871 | $41,346,189 | 0.001 % | under 1 % |
| 2026-09-23 | ClickHouse | $18,240,072 | $18,233,631 | 0.035 % | 0.07 % (SOL_v2) |
| 2026-09-28 | ClickHouse | $12,843,721 | $12,837,394 | 0.049 % | 0.29 % (ETH) |

The gaps come from window alignment: the two windows end a few minutes
apart.
