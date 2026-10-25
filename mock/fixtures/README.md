# c2pool REST fixtures

Real responses captured 2026-10-25 (UTC) with read-only `GET`s from three running
c2pool nodes, then anonymized with `../../tools/fixtures/anonymize.py` (run with
`python3 -I`). Nothing was POSTed and `/control/*` was never touched.

| dir     | coin lane                       | node build                         | state at capture |
|---------|---------------------------------|------------------------------------|------------------|
| `btc/`  | Bitcoin BIP-110 lane (`symbol: BIP110`, `network: bip110`) | `c2pool/dev`, protocol 3600 | idle: 0 miners, 0 sharechain peers, 30 shares, `block_value_basis: projected`, coin sync 99.94 % |
| `ltc/`  | Litecoin + DOGE merged (`share_version: 36`) | `c2pool/0.1.0-alpha`, protocol 3600 | 0 local miners, 7 peers, pool 174 GH/s, 4 payout addresses in window, newer build with `hashing/standby/stalled` |
| `dash/` | Dash (`share_version: 16`, V36 active) | `c2pool/0.1.0-alpha`, protocol 1700 | 25 rigs on one payout address, 44 TH/s local, 3 peers, older build **without** `hashing/standby/stalled` and per-worker `state` |

File name = endpoint path with `/` replaced by `_` (`web_currency_info.json` is
`GET /web/currency_info`). `pplns_miner_addr.json` is `GET /pplns/miner/<address>`
for the first address of that node's `current_payouts`. `_capture.json` lists every
endpoint tried with its HTTP status and raw size; endpoints that answered 404 on a
node (`/version`, `/miners`, `/stratum_sessions`, `/api/*` guesses) have no fixture.

Anonymization (deterministic per coin directory, so one real address maps to the
same placeholder in every file of that directory):

- base58 payout addresses `L…`/`M…`/`X…`/`D…`/`A…`/`3…` -> `<prefix>EXAMPLE<n>xxx…` (same length)
- bech32 `ltc1q…`/`bc1q…` -> `<hrp>1qexample<n>qqq…` (same length)
- 40-hex pubkey hashes (sharechain `shares_by_miner`, `best_share.miner` on LTC/BTC) -> `000…00<n>`
- stratum usernames `ADDR.worker` keep the worker suffix (`XEXAMPLE1xxx….D1`)
- IPv4 -> `203.0.113.<n>`, IPv6 -> `2001:db8::<n>`, ports kept (peer_list, stratum_stats
  `remote_endpoint`/`ip_connections`/`ip_workers`, node_info `external_ip`, api/coin_peers)
- 64-hex block and share hashes are public chain data and are kept
- long arrays are truncated: `recent_blocks` and `network_difficulty` to 3 rows,
  `luck_stats.blocks` to 5, `pplns_miner_addr` series to 5, `sharechain_stats.timeline` to 3.
  `stratum_stats.workers` and the `local_stats.miner_*` maps are kept whole (25 workers on
  DASH) so per-worker sums can be checked against the node's own totals: in the DASH
  capture Σ `workers[].hash_rate` equals `pool.hashrate` exactly (46.956 TH/s) while
  `local_stats.local_hashps` (44.42 TH/s) is a different estimator, 3.9 % lower than
  Σ `miner_hash_rates` in the same payload.

Numbers are untouched. Hashrates are H/s, amounts are whole coins (float, 1e-8
resolution), timestamps are Unix seconds, `fee`/`fee_percent` are percent.

Notes an implementer should know before trusting a field (details in the top-level README):

- `global_stats.network_hashrate` is computed by the node with a hard-coded 150 s block
  period; on the BTC lane it is 4x too high. Recompute from `network_block_difficulty`
  and `web/currency_info.block_period`.
- `pplns/current.miners[].hashrate_hps` and `pplns/miner/<addr>.hashrate_hps` do not agree
  with the stratum figures (DASH: 1.2e15 and 2.7e14 vs 4.4e13 measured) and the
  `hashrate_series` is mostly zeros. Do not use them.
- `pplns/miner/<unknown>` answers HTTP 200 with `{"error":"miner_not_found"}`.
- `miner_thresholds` keys are `*_ltc` on every coin and `block_subsidy_ltc` is a stale
  constant on DASH/BTC. Not used.
- The DASH node's `local_stats.stratum_sessions` lacks `hashing`/`standby`/`stalled` and its
  `stratum_stats.workers[*]` lack `state`/`ever_submitted`/`last_share_age_s`; the version
  string is identical to the LTC node's, so feature-detect by key presence, never by version.
