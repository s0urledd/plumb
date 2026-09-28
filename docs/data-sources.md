# Data sources

## On-chain (authoritative)

- Monad mainnet, chain 143. Exchange `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`
  (contract version 1.7.4 via `getContractVersion()`, Perpl release v1.1.7.4, from `ContractVersionSet` at block 95,662,781; version 1.7.5 from block 107,355,313, 2026-09-23 about 15:20 UTC), collateral AUSD
  `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 decimals (via
  `getExchangeInfo()`).
- Getters used: `getPerpetualExistsBitmap`, `getPerpetualInfoV2`,
  `getMarginFractions`, `getLiquidationInfo`, `getUnwindInfo`,
  `getPositionsV2` (paged), `getPositionV2`, `getAccountById`,
  `numberOfAccounts`, `getFundingInterval`, `getFundingSumAtBlock`,
  `getContractVersion`, `isHalted`, `getExchangeInfo`; order book:
  `getVolumeAtBookPrice`, `getNextPriceBelowWithOrders`,
  `getNextPriceAboveWithOrders` (levels are offsets from `basePricePNS`, which
  is zero on every listed market; `getOrdersAtPriceLevel` was used only to
  confirm that the `exp` volume counters hold expired orders).
- Events indexed since the deployment block 54,773,010 (2026-02-11), from
  the exchange address only (`src/decode.js`):
  - position lifecycle, open to invert (V1 and V2 variants);
  - maker and taker fills;
  - liquidations, deleverages and unwinds;
  - collateral deposits and withdrawals, and protocol balance transfers;
  - `AccountCreated`, `FundingEventCompleted`, `ContractAdded`;
  - buy-to-liquidate settlements, position collateral changes, insurance
    payments;
  - parameter updates.

  The contract-state collector also watches liquidation diagnostics
  (`src/events.js`).
- Multicall3 `0xca11bde05977b3631167028862be2a173976ca11`.

## ABI and formulas

- `perpl-sdk` crate 0.2.8 (crates.io, MIT), `abi/dex/Exchange.json`
  (`REVISION rc_v1.1.7-203-g0e5902dd`), `src/state/position.rs`,
  `src/state/perpetual.rs`, `src/state/exchange.rs`. See `abi/README.md`.
- Perpl documentation: `exchange/margin`, `exchange/liquidation`,
  `exchange/liquidation/insurance-and-adl`, `exchange/funding`
  (docs.perpl.xyz, Markdown versions).

## Reference only

- Perpl public context `https://app.perpl.xyz/api/v1/pub/context`: market
  list, `state.mrk`, `state.oi`, `funding.rate` (×10⁻⁶), `funding.sum`,
  margin fractions. Compared with the contract at `/api/v1/reference` when `REFERENCE_ENABLED=1`; never
  used to compute a metric. The API omits markets 30, 70 and 80, which the
  contract lists with zero positions.

## RPC endpoints

| Endpoint | `eth_getLogs` range | History | `blockTimestamp` on logs | Use |
| --- | --- | --- | --- | --- |
| Monad RPC (Huginn, `monad-rpc`) | 1000 blocks | a few days of logs and state (`LIVE_HISTORY_BLOCKS` defaults to 600,000 blocks, about 2 days at 0.30 s) | yes | Live ingest, recent backfill, contract state |
| https://rpc1.monad.xyz, https://rpc2.monad.xyz | 1000 blocks | archive, from genesis | yes | One-time backfill of older ranges |
| https://rpc.monad.xyz | 100 blocks | recent | not checked | Not used (probed only) |
| https://rpc-mainnet.monadinfra.com | 100 blocks | recent | not checked | Not used |

On the node, 1500-block ranges are rejected, and 1000 unfiltered blocks
exceed the response size limit, so every request filters by the exchange
address and the decoder's topics. Monad finalizes about two blocks (under a
second) behind the proposal. The ingest only asks for explicit block numbers
at or below `finalized`.

Measured block time: about 0.30 s. One funding interval (8,571 blocks) is
about 43 minutes, matching the public context's `funding_interval_sec`.

## Execution events

With `--exec-event-ring` on `monad-execution`, the node publishes block and
transaction events to a shared-memory ring. The Monode sidecar
(`deploy/monode`, pinned upstream commit, execution events SDK
`release/exec-events-sdk-v1.0`) reads it and forwards over a WebSocket, in
restricted mode:
- block lifecycle events: `BlockStart`, `BlockEnd`, `BlockReject`,
  `BlockQC` (voted), `BlockFinalized`;
- `TxnLog` events of the exchange address;
- Monode's own TPS and top-accesses summaries, which are not filtered and
  which Plumb ignores.

Plumb uses them only to wake the ingest and to show proposed trades
early. Stored data always comes from `eth_getLogs` over finalized blocks,
because a log's index in the ring is its position within the transaction,
not within the block.
