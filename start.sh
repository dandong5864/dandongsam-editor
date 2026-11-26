#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 가 필요합니다: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
node server.js
