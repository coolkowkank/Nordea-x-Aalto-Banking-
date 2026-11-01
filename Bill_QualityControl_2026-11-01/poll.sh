#!/bin/bash
# Poll origin/instinct-prototype-v3 every 10 min; exit when line 1 of review.md says TURN: Bill.
cd /root/repo || exit 2
last="$1"
while true; do
  h=$(git ls-remote origin instinct-prototype-v3 | cut -c1-40)
  if [ -n "$h" ] && [ "$h" != "$last" ]; then
    git fetch -q origin instinct-prototype-v3
    line=$(git show "$h:review.md" | head -1)
    author=$(git log -1 --format=%an "$h")
    echo "$(date -Is) new $h author=$author line1=$line"
    last="$h"
    if [ "$line" = "TURN: Bill" ]; then echo "TURN_BILL $h"; exit 0; fi
  fi
  sleep 600
done
