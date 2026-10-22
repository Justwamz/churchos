#!/bin/sh
# Blocks a commit whose staged additions contain a private key header or an obvious token.
# Install: cp scripts/pre-commit-secret-scan.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
added=$(git diff --cached --no-color -U0 --diff-filter=AM | grep '^+' | grep -v '^+++')
pattern='-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk_live_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}'
if printf '%s\n' "$added" | grep -Eq "$pattern"; then
  echo "pre-commit: staged changes look like they contain a secret:" >&2
  printf '%s\n' "$added" | grep -En "$pattern" | cut -c1-80 >&2
  echo "Remove it, or bypass once with: git commit --no-verify (only if it is a false positive)." >&2
  exit 1
fi
exit 0
