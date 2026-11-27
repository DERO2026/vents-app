#!/usr/bin/env python3
"""Generate scripts/ops/0220-precheck.sql from migration 0220's own anchors.

Usage: python3 scripts/ops/gen-0220-precheck.py   (from the repo root)
The precheck is a single read-only SELECT; it evaluates exactly the anchors
and "found exactly once" rule that pg_temp.vents_0220_patch enforces.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
src = (ROOT / 'supabase/migrations/0220_ticket_payment_integrity.sql').read_text()

calls, i = [], 0
while True:
    a = src.find("SELECT pg_temp.vents_0220_patch(", i)
    if a < 0:
        break
    b = src.find("]);", a)
    while src[a:b].count('$a$') % 2:   # skip "]);" inside a $a$...$a$ literal
        b = src.find("]);", b + 1)
    body = src[a + len("SELECT pg_temp.vents_0220_patch("):b + 1]
    m = re.match(r"'([^']+)',\s*", body)
    calls.append((m.group(1), body[m.end():]))
    i = b + 3
assert [c[0] for c in calls] == ['public.purchase_ticket(uuid,text,jsonb,text,text)', 'public.generate_ticket_token(uuid)',
                                 'public.verify_entry_pass(text,uuid,text,text)', 'public.manual_check_in(uuid,uuid,text,text)'], calls

parts = []
for sig, arr in calls:
    parts.append(f"""SELECT '{sig}'::text AS function, i AS anchor,
       CASE WHEN to_regprocedure('{sig}') IS NULL THEN 'MISSING FUNCTION'
            WHEN position('[0220]' IN d.def) > 0 THEN 'ALREADY PATCHED'
            WHEN (length(d.def) - length(replace(d.def, x.p[i][1], ''))) / length(x.p[i][1]) = 1 THEN 'OK'
            ELSE 'BLOCKED (anchor found ' || ((length(d.def) - length(replace(d.def, x.p[i][1], ''))) / length(x.p[i][1]))::text || ' times)' END AS status
  FROM (SELECT CASE WHEN to_regprocedure('{sig}') IS NULL THEN '' ELSE pg_get_functiondef(to_regprocedure('{sig}')) END AS def) d,
       (SELECT {arr} AS p) x,
       generate_subscripts(x.p, 1) AS i""")

header = """-- 0220 production precheck. READ ONLY. Generated from
-- supabase/migrations/0220_ticket_payment_integrity.sql (the same anchors, the
-- same "exactly once" rule), by scripts/ops/gen-0220-precheck.py. Do not edit
-- by hand: regenerate.
--
-- Reports, for each of the four functions 0220 patches and each text anchor
-- it replaces: OK (found exactly once: 0220 would patch it), ALREADY PATCHED,
-- MISSING FUNCTION, or BLOCKED (0220 would refuse: the live function differs).
-- Reads only function definitions. Never writes. Not run against production
-- without the owner's approval.
--
-- Tested locally: scripts/local-pg-test/run-0220-precheck-verification.sh
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
"""
(ROOT / 'scripts/ops/0220-precheck.sql').write_text(header + "\nUNION ALL\n".join(parts) + "\nORDER BY 1, 2;\nROLLBACK;\n")
