# Market logos

Logos identify each market's base asset. They are trademarks of their
owners and are used only to identify the asset.

| File | Asset | Source | Licence |
| --- | --- | --- | --- |
| `mon.svg` | MON | [monad-crypto/token-list](https://github.com/monad-crypto/token-list) `mainnet/MON/logo.svg` (commit `20779d2`) | MIT |
| `sol.svg` | SOL | [monad-crypto/token-list](https://github.com/monad-crypto/token-list) `mainnet/SOL/logo.svg` (commit `20779d2`) | MIT |
| `btc.svg`, `eth.svg`, `zec.svg` | BTC, ETH, ZEC | [spothq/cryptocurrency-icons](https://github.com/spothq/cryptocurrency-icons) `svg/color/` | CC0-1.0 |
| `hype.png` | HYPE | [trustwallet/assets](https://github.com/trustwallet/assets) `blockchains/hyperevm/info/logo.png` | MIT |
| `near.png` | NEAR | [trustwallet/assets](https://github.com/trustwallet/assets) `blockchains/near/info/logo.png`, cut to a circle | MIT |
| `arb.png` | ARB | [trustwallet/assets](https://github.com/trustwallet/assets) `blockchains/arbitrum/info/logo.png` | MIT |
| `uni.png`, `aave.png`, `morpho.png` | UNI, AAVE, MORPHO | [trustwallet/assets](https://github.com/trustwallet/assets) `blockchains/ethereum/assets/<token>/logo.png` | MIT |
| `ena.png` | ENA | [trustwallet/assets](https://github.com/trustwallet/assets) `blockchains/ethereum/assets/0x57e1…6061/logo.png`, placed on a black disc | MIT |
| `pump.png` | PUMP | [trustwallet/assets](https://github.com/trustwallet/assets) `blockchains/solana/assets/pumpCmXq…9Dfn/logo.png` | MIT |
| `vvv.png` | VVV | The Venice token logo, as listed on CoinGecko, placed on a black disc | Project logo |
| `tao.png` | TAO | The Bittensor symbol, as listed on CoinGecko, inverted for the dark theme | Project logo |
| `lit.png` | LIT | The Lighter logo, as listed on CoinGecko | Project logo |

The monad-crypto/token-list lists BTC and ETH only as wrapped tokens
(WBTC, WETH). HYPE, ZEC, LIT, VVV, TAO, PUMP, NEAR, UNI, ARB, AAVE, MORPHO and ENA are not
in it.

Raster logos are cut to a circle and stored at 64 × 64 px, enough for the
16–24 px chips at 3× pixel density. A market with no logo here shows its
colour swatch instead (`logo()` in `web/js/ui.js`).
