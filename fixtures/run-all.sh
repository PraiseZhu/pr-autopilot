#!/usr/bin/env bash
# pr-autopilot fixtures 一键回归 — 任何一项 fail 即退出非零
set -euo pipefail
cd "$(dirname "$0")"
node run-fixtures.mjs
