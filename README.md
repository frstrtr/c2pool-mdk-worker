# c2pool-mdk-worker

[Tether MDK](https://github.com/tetherto/mdk) worker for a self-hosted
[c2pool](https://github.com/frstrtr/c2pool) node. c2pool is a decentralized
p2pool: miners share a PPLNS sharechain instead of an operator's account
database. The worker reads one node's read-only HTTP API and reports local
stratum hashrate and workers, sharechain and peer health, blocks found, and the
projected coinbase payout for a set of payout addresses.

c2pool is non-custodial: miners are paid directly in the coinbase of each block
the pool finds. There is no account, no balance and no withdrawal, so this
worker reports no `balance`. `pending_payout` is the projected coinbase share at
the current block template and `estimated_earnings` is an expectation, not a
settlement.

Built and tested against MDK `35c144f2` (v0.12.0 on `main`; the `v0.12.0` tag
was not yet published when this was pinned). Verified against live BTC
(BIP-110 lane), LTC with merged DOGE, and DASH nodes.

## Install

MDK is not on the npm registry yet, so both MDK and this worker install from
git. Pin each one to a commit SHA, not a branch. In the project that runs your
MDK host:

```bash
npm install github:tetherto/mdk#<mdk-sha> github:frstrtr/c2pool-mdk-worker#<worker-sha>
npm --prefix node_modules/@tetherto/mdk install --ignore-scripts
```

The second command installs MDK's own dependencies, which npm skips for a git
dependency. The worker declares `@tetherto/mdk` as a peer dependency and uses
the copy your project installs. It has no install scripts and no runtime
dependencies of its own; it talks to the node with Node's built-in `fetch`.

## Develop and test

Use Node.js 24 or later and npm 11:

```bash
npm ci --ignore-scripts
npm run setup:mdk
npm test                  # standard, unit tests, integration tests
npm run validate:worker   # MDK worker smoke script against the mock
node examples/mock.js     # every channel against the mock, as JSON
```

`npm test` runs offline: the unit tests read the recorded node responses in
`mock/fixtures/` directly or through the mock server, and the integration tests
use a local DHT test network and a local MDK Kernel. With the MDK CLI
installed, `mdk validate worker --path . --smoke` runs the same smoke checks
plus a pass with the mock stopped, in which every channel must fail with an
`ERR_*` and `health` must report `OFFLINE`. Working next to an MDK checkout?
`npm run setup:local` replaces the pinned copy with a symlink to `../mdk` (or
`$MDK_DIR`). `package-lock.json` fetches MDK over `git+https`, so CI needs no
SSH key; `npm install` writes GitHub dependencies back as `git+ssh`, and a unit
test flags that (the fix is in `tests/unit/package.test.js`).

## Usage

The package is a directory-loaded worker plugin for `WorkerRuntimeV2`:
`mdk-contract.json` plus the handler files it names. One device is one c2pool
node. Several nodes are several devices in one runtime.

```js
const { WorkerRuntimeV2 } = require('@tetherto/mdk/backend/core/mdk-worker')
const { plugin } = require('c2pool-mdk-worker')

const runtime = new WorkerRuntimeV2(plugin.dir, {
  workerId: 'c2pool',
  storeDir: './store/c2pool',            // keeps the RPC key stable across restarts
  allowedKeys: [kernelClientKeyHex],      // the Kernel's kernel.getClientPublicKey()
  devices: [
    {
      deviceId: 'c2pool-btc-1',
      config: { nodeUrl: 'http://127.0.0.1:8080', coin: 'BTC', addresses: ['bc1q...'] }
    }
  ]
})
await runtime.start()
```

MDK v0.12 is fail-closed: `start()` throws `ERR_WORKER_ALLOWED_KEYS_REQUIRED`
without `allowedKeys` (or `allowAll: true`, for a local experiment only).
Signal handling and restarts are the host's job.

### Device config (`c2pool_config_v1`)

| key | type | default | meaning |
|---|---|---|---|
| `nodeUrl` | string | `http://127.0.0.1:8080` | The node's web port. A plain `http:`/`https:` URL, optionally with a path prefix for a reverse proxy; no query, fragment, credentials or `/control` segment. |
| `coin` | string | none | `BTC`, `LTC` or `DASH`, case-insensitive. When set, it must match the node's `/node_info` symbol (`BIP110` satisfies `BTC`). |
| `addresses` | string[] | `[]` | Payout addresses to report on. Matched exactly against the address part of stratum usernames and against the PPLNS window. Empty: every address with a stratum session on this node. |
| `hashrateFloor` | number (H/s) | `null` | Threshold for `alert.hashrate_low`; `null` disables it. |
| `pollIntervalMs` | number | `30000` | How long one poll serves every channel. Minimum 5000. |
| `timeoutMs` | number | `10000` | Per-request timeout. The whole poll fails on the first failed request. |
| `noShareAlertMs` | number | `900000` | Threshold for `alert.no_recent_shares`. |
| `recentBlocks` | number | `50` | Rows of `/recent_blocks` read, 1 to 1000. |

An unknown key is an error (`ERR_C2POOL_CONFIG_INVALID`), so a misspelt
`nodeURL` cannot silently fall back to the default node. Config errors surface
on the first telemetry call, not at load time, so one misconfigured device does
not stop the others. The worker takes no `env` and no credentials: the node's
API is unauthenticated and the worker only reads it.

Point each device at the node your rigs connect to; on a relay node, configure
`addresses`, since it has no stratum sessions to take the scope from. A node
sees only the rigs connected to it; the same address may also hash on other nodes, which
`pplns_share` (pool-wide) reflects and `workers_online` (this node) does not.
PPLNS is pool-wide, so if the same address is configured on two devices, each
device reports its full `pending_payout`.

## Telemetry

"Scope" is the configured `addresses`, or, when none are configured, every
payout address with a stratum session on this node. Amounts are whole coins of
the node's primary coin, named by the `coin` channel (the contract's `unit` is
`coin` because one package serves BTC, LTC and DASH nodes). Hashrates are H/s,
as the node reports them.

| channel | unit | source and meaning |
|---|---|---|
| `hashrate` | H/s | Σ over scope workers of `max(0, stratum_stats.workers[].hash_rate − dead_hash_rate)`: the node's vardiff estimate, net of dead work and clamped at 0 per worker. 0 is a true reading (no rigs in scope here). |
| `hashrate_dead` | H/s | Σ `dead_hash_rate` over scope. |
| `workers_online` | | Scope workers in state `hashing`. A worker is one stratum username, not a connection. |
| `workers_stalled` | | Scope workers in state `stalled`. |
| `workers_standby` | | Scope workers in state `standby`. |
| `workers` | | One row per scope worker: `{ name, address, worker, hashrate, hashrate_dead, difficulty, connections, accepted, rejected, stale, state, last_share_age_s, connected_seconds }`, sorted by name, at most 1000. No IPs or endpoints. |
| `pplns_share` | | Σ `pplns/current.miners[].pct` over scope, 0..1. Pool-wide. |
| `pending_payout` | coin | Σ `pplns/current.miners[].amount` over scope: what the scope would be paid in the coinbase if the pool found a block now, net of pool fee. Decays as shares leave the window. |
| `pending_payout_merged` | | `{ SYMBOL: amount }` over scope from `miners[].merged[]`, every merged chain listed; `{}` on BTC and DASH. |
| `estimated_earnings` | coin | `expected_blocks_per_day × pending_payout`, coins per day. See below. |
| `expected_blocks_per_day` | | `pool_hash_rate × 86400 / (network_block_difficulty × 2^32)`. |
| `pool_hashrate` | H/s | `global_stats.pool_hash_rate`: whole pool, estimated from the sharechain window; lags real changes by hours. |
| `network_difficulty` | | `global_stats.network_block_difficulty`. |
| `network_hashrate` | H/s | `network_difficulty × 2^32 / block_period`, block period from `/web/currency_info` (BTC 600 s, LTC and DASH 150 s). |
| `block_value` | | `{ total, miner_net, miner_gross, fee, payments, basis, height, age_sec, fee_percent }` of the current template, from `/local_stats`. |
| `blocks_found_24h` | | Rows of `/recent_blocks` from the last 24 h that are not `orphaned`, pool-wide. |
| `last_block_found` | | Row 0 of `/recent_blocks`: `{ height, hash, ts, found_by, status, confirmations, block_reward, explorer_url }`, or `null`. |
| `share_difficulty` | | `global_stats.min_difficulty`, the pool's share-difficulty floor. |
| `stale_rate` | | `local_stats.my_stale_proportions_in_last_hour.stale`, window-wide, 0..1. |
| `efficiency` | | `local_stats.efficiency`, valid / all shares in the window. |
| `sharechain` | | `{ synced, height, shares_in_window, window_size, verified, peers_in, peers_out, unique_miners, orphan_rate, doa_rate, local_orphan_rate?, protocol_version, share_version, coin_chain? }`. |
| `peers` | | Sharechain P2P peers, incoming + outgoing (not coin peers). |
| `coin` | | `/node_info.symbol`: `BTC`, `BIP110`, `LTC` or `DASH`. |
| `node` | | `{ version, protocol_version, role, uptime_s, network, worker_port, warnings }`; `warnings` are the node's own banners, at most 20. |
| `health` | | `{ status, alerts, detail }`, see below. |

A channel never reports 0 because a read failed. When its input is missing or
malformed it fails with `ERR_C2POOL_DATA <field>`; when the node cannot be
polled every channel fails with the poll's error. `share_difficulty` fails while
the node reports `null` (sharechain too young), and the four PPLNS payout
channels fail with `ERR_C2POOL_NOT_READY` while `/web/sync_status.ready` is
false. On a relay node (no stratum acceptor) the six local-miner channels fail
with `ERR_C2POOL_RELAY_NODE`. A relay node has no stratum sessions, so unless
`addresses` is configured the scope is empty and the PPLNS channels
(`pplns_share`, `pending_payout`, `pending_payout_merged`,
`estimated_earnings`) read a true 0; configure `addresses` on a device that
points at a relay node.

### Worker states

c2pool marks a stratum connection silent when no share was accepted for
max(900 s, 6 expected share intervals at its difficulty), capped at 7 days.

- `hashing`: has shared on this node and is not silent.
- `standby`: connected, never shared here. Normal for a failover connection; not a fault.
- `stalled`: shared on this node, then went silent.

Newer node builds report the state per worker; on older builds the worker
derives it with the same rule from `accepted` and `silent`. Builds are told
apart by which keys are present, never by the version string.

### `estimated_earnings`

There is no settlement to scale, so the figure is an expectation:

```
blocks_per_day     = pool_hash_rate × 86400 / (network_block_difficulty × 2^32)
estimated_earnings = blocks_per_day × pending_payout
```

It assumes that:

1. pool hashrate and network difficulty stay at their current values for 24 h;
2. the scope's share of the window stays as it is (after a rig change it
   converges over one window, `shares_in_window` shares);
3. the block value stays at the current template;
4. found blocks are not orphaned (stale shares are already out of the window).

Realized income over a day is 0, or one or more whole payouts. For a small
pool the standard deviation exceeds the mean; read `expected_blocks_per_day`
before acting on the number. From the recorded fixtures: DASH 4.54 blocks/day
× 0.411 DASH = 1.87 DASH/day; LTC 0.0381 blocks/day (one per ~26 days) × 6.19
LTC = 0.236 LTC/day; an idle BTC (BIP-110) sharechain at 1.09e-6 blocks/day
gives 3.4e-6 BTC/day, which is numerically honest and useless. Merged coins
are not included; see `pending_payout_merged`.

## Health and troubleshooting

| status | when |
|---|---|
| `OFFLINE` | The last poll failed (unreachable, non-2xx, bad JSON, wrong coin) or the device config is invalid. `alerts` is `['alert.pool_unreachable']` and `detail.error` the `ERR_*` code. |
| `DEGRADED` | The poll succeeded and at least one alert below fires. |
| `OK` | The poll succeeded and no alert fires. |

| alert | fires when |
|---|---|
| `alert.pool_unreachable` | See `OFFLINE`. The name is the MDK convention; the node may be down while the pool is fine. |
| `alert.sharechain_not_synced` | `/web/sync_status.ready` is false, or `/api/node_topology` reports the primary coin's headers as not synced. |
| `alert.no_peers` | The node has no sharechain peers, or its embedded coin P2P client (DASH build) is not `connected`. |
| `alert.hashrate_low` | `hashrateFloor` is set and `hashrate` is below it on this poll and the previous successful one. |
| `alert.workers_stalled` | At least one scope worker is `stalled`; `detail.stalled_workers` names them. |
| `alert.no_recent_shares` | Scope workers are connected, none is `hashing`, and every connection is older than `noShareAlertMs`. |
| `alert.data_unavailable` | The node answered, but an input one of the rules above needs (readiness, peers, coin P2P state, node role, or on a mining node the scope's workers and hashrate) is missing or malformed, so that rule could not be evaluated. `detail.unavailable` names the inputs. |

`detail` carries the numbers the rules used, including both hashrate
estimators (`stratum_hashrate` and the node's `local_hashps`, a few percent
apart), and `notes`: the node's warnings, a projected block value (no live
template, subsidy only), a template older than 3 block periods, and any rule
that could not be evaluated, with its `ERR_C2POOL_DATA` message. A rule that
could not be evaluated never leaves the status at `OK`. `detail` never echoes
the device config.

- If `alert.pool_unreachable`, check that the c2pool process is running and that `nodeUrl` points at its web port (default 8080).
- If `alert.sharechain_not_synced`, the node is downloading or verifying the sharechain or its coin headers; wait, then check `/web/sync_status` and `/api/node_topology` on the node.
- If `alert.no_peers`, check that the node's p2p port (`/node_info.p2p_port`) is reachable and that it has bootstrap peers; until then its shares cannot propagate.
- If `alert.hashrate_low`, compare with the rigs' own dashboards first; a few rigs on a high share difficulty are noisy over minutes.
- If `alert.workers_stalled`, check the listed rigs and their network path.
- If `alert.no_recent_shares`, check the stratum username (`ADDRESS.worker` with a valid payout address for the coin) and the rigs' difficulty settings.
- If `alert.data_unavailable`, the node reports a shape this worker does not know for the input named in `detail.unavailable`; check the node version and the message in `detail.notes`.

### Errors

| code | meaning |
|---|---|
| `ERR_C2POOL_NODE_UNREACHABLE` | No HTTP response within `timeoutMs` (refused, DNS, TLS, timeout, or a port `fetch` refuses to dial). The message names the path and the transport code. |
| `ERR_C2POOL_HTTP` | The node answered a non-2xx status, including a redirect, which is never followed. |
| `ERR_C2POOL_DATA` | A response or a field in it is missing or malformed, or a response body is over 4 MiB; the message names the field, or the path and size. |
| `ERR_C2POOL_NODE_URL_INVALID` | `nodeUrl` is not a plain http(s) URL. |
| `ERR_C2POOL_ADDRESS_INVALID` | An entry of `addresses` is empty, duplicated or not an address string. |
| `ERR_C2POOL_CONFIG_INVALID` | An unknown config key, or a value of the wrong type or out of range; the message names the key. |
| `ERR_C2POOL_COIN_MISMATCH` | The configured `coin` does not match the node. |
| `ERR_C2POOL_RELAY_NODE` | The node runs without a stratum acceptor; point the device at the node your rigs connect to. |
| `ERR_C2POOL_NOT_READY` | The node is up but not ready (no verified shares or no work template); the payout channels fail with it. |
| `E_POOL_API` | Generic pool API failure, kept for MDK compatibility; the thrown message always carries one of the codes above. |

## Requests

One poll is `GET /local_stats`, then in parallel `/stratum_stats`,
`/global_stats`, `/pplns/current`, `/recent_blocks`, `/web/sync_status` and,
where the build has it, `/api/node_topology`. `/node_info` and
`/web/currency_info` are read on the first poll and then once an hour. With the
default `pollIntervalMs` that is at most 14 requests a minute per device, about
60 KB per poll on a node with 25 rigs. Concurrent channel reads share one
in-flight poll, and a failed poll is reused for 10 s, so a down node costs one
request per metrics pull. Every request is a `GET` with a timeout, to a fixed
allow-list of paths, with redirects refused and the response body capped at
4 MiB.

## Mock and live check

`npm run mock` serves the recorded DASH responses on `127.0.0.1:8080`, so a
device with the default config reads it; `node mock/server.js --coin ltc`
serves another set. The mock is plain HTTP and knows nothing about MDK.
`mock/state.js` can apply scenarios on top of the recordings (node offline, 500
errors, slow responses, not synced, no peers, stalled workers, scaled hashrate,
an older build without per-worker state, a relay node, another coin symbol);
the tests use them. The recordings and how they were anonymized are described
in [mock/fixtures/README.md](mock/fixtures/README.md);
`tools/fixtures/capture.sh` re-captures them from a node.

To check a real node, run every handler against it read-only:

```bash
C2POOL_NODE_URL=http://127.0.0.1:8080 C2POOL_COIN=DASH node examples/verify-live.js
# optional: C2POOL_ADDRESSES=addr1,addr2
```

It prints each channel, and exits 1 if a channel fails, returns the wrong type
or puts an IP-address-like string in its output.

## Multi-coin notes

- BTC: the BIP-110 lane reports `coin: "BIP110"` and `node.network: "bip110"`
  and satisfies `coin: "BTC"`. On an idle node `block_value.basis` is
  `projected` (subsidy only, no fees).
- LTC: merged DOGE payouts are in `pending_payout_merged`; stratum usernames
  may be `LTCADDR,DOGEADDR.worker`, scoped by the LTC address.
- DASH: `block_value.payments` holds the masternode, superblock and platform
  lanes, and `miner_net` is what PPLNS splits. The DASH build also reports
  `sharechain.local_orphan_rate` and the embedded coin P2P state used by
  `alert.no_peers`.

The node's own `global_stats.network_hashrate` assumes a 150 s block period on
every coin (4x too high on BTC), and `pplns/current.miners[].hashrate_hps`
disagrees with the stratum figures; the worker uses neither.

## Security

The worker only reads. It sends `GET` to a fixed list of paths, never calls
`/control/*`, refuses a `nodeUrl` under `/control`, and has no command handlers.
It needs no credentials. c2pool shows miner IP addresses to loopback callers,
so the worker drops every `remote_endpoint`, `ip_*` and `external_ip` field
before anything leaves a handler, wherever it runs. Keep the node's web port
off the public Internet or behind your own proxy. See [SECURITY.md](SECURITY.md)
to report a problem.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
