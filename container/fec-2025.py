#!/usr/bin/env python3
"""Drive the bot's browser to FEC 2025 individual contributions -- by hand, no LLM.

Proves the action layer end to end: navigate, click by ref, fill a form, submit,
read the resulting table. Every step is the same /act call the agent will make.
"""
import json, re, sys, urllib.request

SHIM = "http://127.0.0.1:18088"

def act(action, **args):
    body = json.dumps({"action": action, **args}).encode()
    req = urllib.request.Request(f"{SHIM}/act", body, {"content-type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=120))
    if not r.get("ok"):
        sys.exit(f"FAILED {action}: {r.get('error')} - {r.get('message')}")
    return r

def ref_for(snapshot, role, name, after=None):
    """Find a ref the way the model would: by role + accessible name.

    `after` disambiguates by position. This page has eight buttons whose
    accessible name is "Search" -- the header site-search, one per filter field,
    and the one that applies the date range. Name alone is not enough; the model
    would use the snapshot's ordering, so this does too.
    """
    start = 0
    if after:
        i = snapshot.find(f"[ref={after}]")
        if i < 0:
            sys.exit(f"anchor ref {after} not in snapshot")
        start = i
    pat = re.compile(rf'- {re.escape(role)} "{re.escape(name)}"[^\n]*\[ref=(s\d+e\d+)\]')
    m = pat.search(snapshot, start)
    if not m:
        sys.exit(f"no {role} named {name!r} in snapshot (after={after})")
    return m.group(1)

urllib.request.urlopen(urllib.request.Request(
    f"{SHIM}/session", json.dumps({"allowed_domains": ["fec.gov"]}).encode(),
    {"content-type": "application/json"})).read()

print("1. navigate to fec.gov/data")
snap = act("navigate", url="https://www.fec.gov/data/")["snapshot"]

print("2. click 'All contributions in this year'")
r = act("click", ref=ref_for(snap, "link", "All contributions in this year"),
        element="All contributions in this year")
snap = r["snapshot"]
print(f"   -> {r['url'][:95]}")

print("3. set the date filter to 2025 (page defaulted to 2026)")
beg, end = ref_for(snap, "textbox", "Beginning"), ref_for(snap, "textbox", "Ending")
act("type", ref=beg, element="Beginning date", text="01/01/2025")
# refs survive because type() no longer regenerates the snapshot
act("type", ref=end, element="Ending date", text="12/31/2025")
print(f"   beginning={beg} ending={end} (both refs still valid)")

print("4. submit the filter")
# the Search that applies the date range is the one *after* the Ending field
r = act("click", ref=ref_for(snap, "button", "Search", after=end), element="Apply date filter")
snap = r["snapshot"]
print(f"   -> {r['url'][:110]}")

print("5. wait for the table to actually re-render with 2025 rows")
# Waiting on "filtered results" is a trap: that text is already on the page from
# the pre-filter state, so it matches instantly and you read stale rows while the
# SPA is still fetching. Wait for evidence of the NEW data instead.
# Scope to the results table. "/2025" also appears in the filter chips, so an
# unscoped wait matches in 3ms while the grid is still showing 2026 rows.
w = act("wait_for", selector="table", text="/2025", timeout_s=60)
if not w.get("matched"):
    sys.exit("table never re-rendered with 2025 dates")
print(f"   re-rendered after {w['waited_ms']} ms")

print("6. read the results\n")
text = act("read_text", max_chars=20000)["text"]

count = re.search(r"Viewing (?:about )?([\d,]+) filtered results", text)
if count:
    print(f"   RESULT COUNT: {count.group(1)} individual contributions in 2025")

# The grid renders as tab-separated columns, one row per line.
rows = re.findall(
    r"^([^\t\n]+)\t([^\t\n]+)\t([A-Z]{2})\t([^\t\n]*)\t(\d{2}/\d{2}/\d{4})\t\$([\d,]+\.\d{2})",
    text, re.M)
print(f"   PARSED ROWS: {len(rows)}\n")
for c, rec, st, emp, date, amt in rows[:12]:
    print(f"   {date}  {'$' + amt:>12}  {c[:28]:<28} -> {rec[:30]:<30} [{st}]")

years = {d.split('/')[-1] for _, _, _, _, d, _ in rows}
print(f"\n   date years present: {sorted(years)}  (expect only 2025)")
if years != {"2025"}:
    sys.exit(f"STALE DATA: expected only 2025, got {sorted(years)}")
total = sum(float(a.replace(',', '')) for *_, a in rows)
print(f"   page total: ${total:,.2f} across {len(rows)} rows")

json.dump(
    {"source": "fec.gov/data (browser)", "period": "2025",
     "result_count": count.group(1) if count else None,
     "rows": [dict(zip(("contributor","recipient","state","employer","date","amount"), r)) for r in rows]},
    open("/home/alfrednutile/.local/share/grokked/bots/bot-alpha/work/out/fec-2025.json", "w"), indent=2)
print("\n   wrote work/out/fec-2025.json")
