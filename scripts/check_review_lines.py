#!/usr/bin/env python3
"""OWNER (03:02, via review.md): pre-commit guard - no CMP message line over 150 chars.
Checks fenced message blocks under '### [Name]' headers in review.md. Exit 1 on violation.
Install: git hooks are not cloned, so run `npm run check:review` (wired into test:arch) or
copy to .git/hooks/pre-commit locally."""
import re, sys

path = sys.argv[1] if len(sys.argv) > 1 else 'review.md'
lines = open(path, encoding='utf-8').read().splitlines()
in_msg = in_fence = False
bad = []
for i, line in enumerate(lines, 1):
    if re.match(r'^### \[\w+\]', line):
        in_msg, in_fence = True, False
        continue
    if in_msg and line.startswith('```'):
        in_fence = not in_fence
        continue
    if in_msg and line.startswith('### '):
        in_msg = False
    if in_msg and in_fence and len(line) > 150:
        bad.append((i, len(line)))
if bad:
    for n, ln in bad:
        print(f'{path}:{n}: CMP line {ln} chars (>150)')
    sys.exit(1)
print(f'{path}: all CMP message lines <= 150 chars')
