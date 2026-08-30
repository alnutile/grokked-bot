#!/usr/bin/env bash
# Drive the bot's browser by hand, with no model in the loop.
#   ./act.sh navigate url=https://www.fec.gov/data/
#   ./act.sh snapshot
#   ./act.sh click ref=s2e14
#   ./act.sh read_text max_chars=3000
set -euo pipefail
SHIM="${SHIM:-http://127.0.0.1:18088}"
action="$1"; shift

# key=value args -> JSON, numbers and bools unquoted
args=$(python3 - "$@" <<'PY'
import json, sys
out = {}
for a in sys.argv[1:]:
    k, _, v = a.partition('=')
    if v.lower() in ('true','false'):        out[k] = v.lower() == 'true'
    elif v.lstrip('-').isdigit():            out[k] = int(v)
    elif v.startswith('[') or v.startswith('{'):
        try: out[k] = json.loads(v)
        except Exception: out[k] = v
    else:                                    out[k] = v
print(json.dumps(out))
PY
)

body=$(python3 -c "import json,sys; d=json.loads(sys.argv[2]); d['action']=sys.argv[1]; print(json.dumps(d))" "$action" "$args")

curl -sS -X POST "$SHIM/act" \
  -H 'content-type: application/json' \
  ${SHIM_TOKEN:+-H "Authorization: Bearer $SHIM_TOKEN"} \
  -d "$body" \
| python3 -c '
import json, sys
r = json.load(sys.stdin)
if "image_base64" in r:
    n = len(r.pop("image_base64"))
    r["image_bytes_b64"] = n
snap = r.pop("snapshot", None)
text = r.pop("text", None)
print(json.dumps(r, indent=2)[:2000])
if snap:  print("\n--- snapshot ---\n" + snap)
if text:  print("\n--- text ---\n" + text)
'
