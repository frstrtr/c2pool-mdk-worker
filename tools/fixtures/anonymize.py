#!/usr/bin/env python3
"""Turn raw c2pool REST captures into committable fixtures.

Input : <raw-dir>/<coin>/<endpoint>.json  (body + trailing __HTTP_<code>__ marker,
        as written by `curl -w '\\n__HTTP_%{http_code}__'`)
Output: <out-dir>/<coin>/<endpoint>.json   (pretty JSON, anonymized, truncated)
        <out-dir>/<coin>/_capture.json     (per-coin capture manifest)

Anonymization rules (deterministic within one run):
  * payout addresses -> obvious placeholders of the same length and charset
      base58  1.../3.../L.../M.../X.../7.../D.../A.../9...   (mainnet)
              m.../n.../2.../y...                            (testnet)
                                              -> <prefix>EXAMPLE<n>xxxx...
      bech32  bc1/tb1/bcrt1/ltc1/tltc1/rltc1  -> <hrp>1qexample<n>qqqq...
      40-hex pubkey hashes                    -> 0000...000<n>
    applied to keys and values, including "ADDR.worker" and "ADDR1,ADDR2.worker".
  * IPv4[:port] -> 203.0.113.<n>[:port]  (TEST-NET-3), IPv6 -> 2001:db8::<n>
    applied to keys and values (peer_list, stratum_stats ip_*, remote_endpoint,
    node_info.external_ip, api/coin_peers).
  * 64-hex block/share hashes are public chain data and are kept.
  * long arrays are truncated to a few entries (see TRUNCATE); per-worker maps are kept whole.
  * idempotent: a placeholder from an earlier run, and an address in the
    documentation ranges 203.0.113.0/24 and 2001:db8::/32, is left as it is,
    so running this over committed fixtures must change nothing.

Run with `python3 -I` so nothing is imported from the capture directory.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

# Version prefixes: BTC 1/3, LTC L/M(/3), DASH X/7, DOGE D/A/9, testnets m/n/2, DASH testnet y.
# The lookahead keeps a long all-digit string from being taken for an address.
BASE58 = re.compile(r'^(?=.*[A-Za-z])(?P<p>[13LMX7DA9mn2y])[1-9A-HJ-NP-Za-km-z]{25,34}$')
BECH32 = re.compile(r'^(?P<hrp>bc|tb|bcrt|ltc|tltc|rltc)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}$', re.IGNORECASE)
HEX40 = re.compile(r'^[0-9a-f]{40}$')
# Output of an earlier run.
PLACEHOLDER = re.compile(r'EXAMPLE\d+|example\d+|^0{30,}\d+$')
DOC_IP = re.compile(r'^\[?(203\.0\.113\.\d{1,3}|2001:db8:[0-9a-fA-F:]*)\]?(:\d{1,5})?$')
IPV4 = re.compile(r'^(?P<ip>(?:\d{1,3}\.){3}\d{1,3})(?P<port>:\d{1,5})?$')
IPV6 = re.compile(r'^\[?(?P<ip>[0-9a-fA-F:]*:[0-9a-fA-F:]+)\]?(?P<port>:\d{1,5})?$')

# endpoint-file -> {json-path-ish key: max entries}
TRUNCATE = {
    'recent_blocks': 3,            # top-level array
    'network_difficulty': 3,       # top-level array
    'luck_stats': {'blocks': 5},
    # stratum_stats.workers and the local_stats miner_* maps are kept whole so
    # per-worker sums can be checked against the node's own totals.
    'pplns_miner_addr': {'hashrate_series': 5, 'recent_shares': 5},
    'sharechain_stats': {'timeline': 3, 'heads': 2, 'verified_heads': 2},
    'api_coin_peers': {'doge': 3, 'ltc': 3},
    'version_signaling': None,     # kept whole: small, no addresses
}


class Anonymizer:
    def __init__(self):
        self.addr = {}
        self.ip = {}

    def _placeholder_addr(self, s):
        if s in self.addr:
            return self.addr[s]
        n = len(self.addr) + 1
        m = BASE58.match(s)
        if m:
            body = f'EXAMPLE{n}'
            out = m.group('p') + body + 'x' * (len(s) - 1 - len(body))
        else:
            m = BECH32.match(s)
            if m:
                body = f'example{n}'
                head = m.group('hrp') + '1q'
                out = head + body + 'q' * (len(s) - len(head) - len(body))
            else:  # hex40
                out = f'{n:040d}'
        self.addr[s] = out
        return out

    def _placeholder_ip(self, ip, port):
        if ip not in self.ip:
            n = len(self.ip) + 1
            self.ip[ip] = f'2001:db8::{n:x}' if ':' in ip else f'203.0.113.{n}'
        out = self.ip[ip]
        if port:
            out = (f'[{out}]' if ':' in out else out) + port
        return out

    def scrub_string(self, s):
        if not isinstance(s, str) or not s:
            return s
        # "ADDR.worker" / "ADDR1,ADDR2.worker" stratum usernames
        if '.' in s and not IPV4.match(s) and not IPV6.match(s):
            head, _, tail = s.partition('.')
            parts = [self._maybe_addr(p) for p in head.split(',')]
            if any(a != b for a, b in zip(parts, head.split(','))):
                return ','.join(parts) + '.' + tail
        if ',' in s:
            parts = s.split(',')
            scrubbed = [self._maybe_addr(p) for p in parts]
            if scrubbed != parts:
                return ','.join(scrubbed)
        a = self._maybe_addr(s)
        if a != s:
            return a
        if DOC_IP.match(s):
            return s
        m = IPV4.match(s)
        if m:
            return self._placeholder_ip(m.group('ip'), m.group('port'))
        m = IPV6.match(s)
        if m and s.count(':') >= 2:
            return self._placeholder_ip(m.group('ip'), m.group('port'))
        return s

    def _maybe_addr(self, s):
        if PLACEHOLDER.search(s):
            return s
        if BASE58.match(s) or BECH32.match(s) or HEX40.match(s):
            return self._placeholder_addr(s)
        return s

    def walk(self, node):
        if isinstance(node, dict):
            return {self.scrub_string(k): self.walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [self.walk(v) for v in node]
        return self.scrub_string(node)


def truncate(name, node):
    rule = TRUNCATE.get(name)
    if rule is None:
        return node
    if isinstance(rule, int):
        return node[:rule] if isinstance(node, list) else node
    for path, n in rule.items():
        cur = node
        keys = path.split('.')
        for k in keys[:-1]:
            cur = cur.get(k, {}) if isinstance(cur, dict) else {}
        last = keys[-1]
        if isinstance(cur, dict) and last in cur:
            v = cur[last]
            if isinstance(v, list):
                cur[last] = v[:n]
            elif isinstance(v, dict):
                cur[last] = dict(list(v.items())[:n])
    return node


def main(raw_dir, out_dir):
    for coin in sorted(os.listdir(raw_dir)):
        src = os.path.join(raw_dir, coin)
        if not os.path.isdir(src):
            continue
        dst = os.path.join(out_dir, coin)
        os.makedirs(dst, exist_ok=True)
        anon = Anonymizer()
        manifest = {'coin': coin, 'captured_utc': None, 'endpoints': {}}
        for fn in sorted(os.listdir(src)):
            if not fn.endswith('.json'):
                continue
            name = fn[:-5]
            text = open(os.path.join(src, fn), encoding='utf-8').read()
            m = re.search(r'__HTTP_(\d{3})__\s*$', text)
            code = int(m.group(1)) if m else 200
            body = text[:m.start()] if m else text
            manifest['endpoints'][name] = {'http': code, 'bytes_raw': len(body.strip())}
            if code != 200:
                continue
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                manifest['endpoints'][name]['note'] = 'non-JSON body, skipped'
                continue
            data = truncate(name, anon.walk(data))
            with open(os.path.join(dst, fn), 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, sort_keys=True)
                f.write('\n')
            manifest['captured_utc'] = manifest['captured_utc'] or datetime.fromtimestamp(
                os.path.getmtime(os.path.join(src, fn)), tz=timezone.utc).isoformat(timespec='seconds')
        manifest['addresses_replaced'] = len(anon.addr)
        manifest['ips_replaced'] = len(anon.ip)
        with open(os.path.join(dst, '_capture.json'), 'w', encoding='utf-8') as f:
            json.dump(manifest, f, indent=2, sort_keys=True)
            f.write('\n')
        print(f'{coin}: {len(manifest["endpoints"])} endpoints, '
              f'{len(anon.addr)} addresses and {len(anon.ip)} IPs replaced')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('usage: anonymize-fixtures.py <raw-dir> <out-dir>')
    main(sys.argv[1], sys.argv[2])
