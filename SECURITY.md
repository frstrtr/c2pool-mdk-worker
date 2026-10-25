# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub's private vulnerability reporting on this repository (Security
tab, "Report a vulnerability").

Include the affected version or commit, steps to reproduce, and the impact you
observed. Do not include real payout addresses, miner IP addresses or node
logs that contain them; anonymize them as in `mock/fixtures/README.md`.

## Scope

The worker reads a c2pool node's HTTP API with `GET` requests only and never
calls `/control/*`. Problems in that boundary are in scope: a request the
worker should not make, a miner IP address or endpoint reaching telemetry, or a
config value echoed where it should not be. Vulnerabilities in c2pool itself
belong to https://github.com/frstrtr/c2pool, and those in MDK to
https://github.com/tetherto/mdk.

## Supported versions

Fixes are made on the latest release. Please confirm an issue against the
newest version before reporting it.
