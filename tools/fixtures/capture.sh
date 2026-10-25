#!/usr/bin/env bash
# Capture a c2pool node's REST responses and turn them into mock fixtures.
# GET only; /control/* is never requested.
#
#   tools/fixtures/capture.sh <btc|ltc|dash> [nodeUrl]
#
# Raw responses go to tools/fixtures/raw/<coin>/ (git-ignored: they hold real
# payout addresses and miner IPs). anonymize.py then writes the committable
# fixtures to mock/fixtures/<coin>/. Review the result before committing.
set -euo pipefail

coin=${1:?usage: capture.sh <btc|ltc|dash> [nodeUrl]}
node=${2:-http://127.0.0.1:8080}
node=${node%/}
case "$node" in
  *control*) echo "refusing a node URL containing 'control'" >&2; exit 1 ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
raw="$here/raw"
mkdir -p "$raw/$coin"

paths=(
  node_info web/currency_info local_stats stratum_stats global_stats pplns/current
  recent_blocks web/sync_status api/node_topology
  best_share luck_stats sharechain/stats peer_list p2p_stats stale_rates current_payouts
  current_merged_payouts merged_stats recent_merged_blocks connected_miners users user_stales
  fee rate local_rate global_rate difficulty uptime payout_addr payout_addrs miner_thresholds
  network_difficulty version_signaling p2pool_global_stats api/coin_peers web/version
)

get () {
  curl -sS --get --max-time 30 -H 'Accept: application/json' -w '\n__HTTP_%{http_code}__' "$node/$1" > "$2" \
    || echo "failed: $1" >&2
}

for p in "${paths[@]}"; do
  get "$p" "$raw/$coin/${p//\//_}.json"
done

# /pplns/miner/<address> for the first address of current_payouts.
addr=$(python3 -I -c '
import json, sys
text = open(sys.argv[1], encoding="utf-8").read().rsplit("\n__HTTP_", 1)[0]
try:
    print(next(iter(json.loads(text))))
except Exception:
    pass
' "$raw/$coin/current_payouts.json")
if [ -n "$addr" ]; then
  get "pplns/miner/$addr" "$raw/$coin/pplns_miner_addr.json"
fi

python3 -I "$here/anonymize.py" "$raw" "$repo/mock/fixtures"
