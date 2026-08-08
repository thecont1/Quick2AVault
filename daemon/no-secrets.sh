#!/usr/bin/env bash
# Fail the build if personal data or secrets are staged/committed.
#
#   ./daemon/no-secrets.sh            check tracked files
#   ./daemon/no-secrets.sh --staged   check what's about to be committed
#
# Financial software handling someone's real bank statements must never leak
# their account numbers into a public repo. This is a blunt instrument on
# purpose: false positives are cheap, a leaked account number is not.
set -uo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-tracked}"
if [ "$MODE" = "--staged" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM)
else
  FILES=$(git ls-files)
fi
# Only scan our own source; vendored/binary trees are noise.
FILES=$(printf '%s\n' "$FILES" | grep -E '^(daemon|desktop|main|renderer)/' | grep -vE 'node_modules|\.(png|icns|jpg|pdf|lock)$' || true)
[ -z "$FILES" ] && { echo "no source files to scan"; exit 0; }

fail=0
flag() { printf '  \033[31mLEAK\033[0m  %s\n' "$1"; fail=1; }

scan() { # scan <label> <regex>
  local hits
  # Exclusions are deliberately NARROW. An over-broad filter makes the scanner
  # pass while real data walks through — e.g. excluding /[0-9]{13}"/ to skip
  # epoch timestamps also skipped every quoted 13-digit account number.
  hits=$(printf '%s\n' "$FILES" | xargs grep -nIE "$2" 2>/dev/null \
    | grep -viE 'no-secrets\.sh' \
    | grep -viE 'synthetic|placeholder|fixture|dummy' \
    | grep -viE 'example (bank|broker|corp|holdings)' \
    | grep -vE '\b0{6,}\b' \
    | grep -viE 'internalDate' \
    || true)
  [ -n "$hits" ] && { flag "$1"; printf '%s\n' "$hits" | head -5 | sed 's/^/          /'; }
}

echo "Scanning for personal data and secrets…"

# Secrets
scan "API key literal"        'sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}'
scan "hardcoded bearer token" 'Bearer [A-Za-z0-9]{16,}'
scan "private key"            'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'

# Indian tax identifiers with a real-looking body (synthetic ones use A0 runs)
scan "PAN-shaped identifier"   '\b[A-Z]{5}[0-9]{4}[A-Z]\b(?!.*synthetic)'
scan "GSTIN-shaped identifier" '\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}\b'

# Long digit runs that look like bank accounts (11-18 digits)
scan "possible account number" '\b[0-9]{11,18}\b'

# Card-like 16-digit runs
scan "possible card number"    '\b(?:[0-9]{4}[ -]?){4}\b'

if [ "$fail" -eq 0 ]; then
  echo "  clean — no personal data or secrets found"
else
  echo
  echo "  Replace real values with synthetic ones (Example Bank, 4242, AAAAA0000A)."
fi
exit $fail
