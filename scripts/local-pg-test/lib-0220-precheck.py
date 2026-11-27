#!/usr/bin/env python3
"""Helpers for run-0220-precheck-verification.sh (local tests only).

  scan <precheck.sql>        exit 1 if a write keyword appears outside comments
                             and outside the $a$...$a$ anchor literals (the
                             anchors are function text and contain SQL words)
  drift-sql <0220.sql>       print SQL that makes 0220's first
                             verify_entry_pass anchor appear twice (copied into
                             a comment), i.e. an untracked edit 0220 must refuse
"""
import re
import sys


def scan(path: str) -> int:
    s = open(path).read()
    s = re.sub(r'\$a\$.*?\$a\$', '', s, flags=re.S)
    s = '\n'.join(line for line in s.splitlines() if not line.strip().startswith('--'))
    hit = re.search(r'\b(insert|update|delete|alter|create|drop|grant|revoke|truncate|copy|perform|execute|call)\b', s, re.I)
    if hit:
        print(f'write keyword found: {hit.group(0)}')
        return 1
    return 0


def drift_sql(path: str) -> int:
    s = open(path).read()
    a = s.index("SELECT pg_temp.vents_0220_patch('public.verify_entry_pass(text,uuid,text,text)'")
    start = s.index('$a$', a) + 3
    anchor = s[start:s.index('$a$', start)]
    assert '$z$' not in anchor and '*/' not in anchor
    print("DO $d$ DECLARE v text := pg_get_functiondef('public.verify_entry_pass(text,uuid,text,text)'::regprocedure); BEGIN\n"
          "  EXECUTE replace(v, E'AS $function$\\n', E'AS $function$\\n/* untracked copy:\\n' || $z$" + anchor + "$z$ || E'\\n*/\\n');\n"
          "END $d$;")
    return 0


if __name__ == '__main__':
    cmd, arg = sys.argv[1], sys.argv[2]
    sys.exit(scan(arg) if cmd == 'scan' else drift_sql(arg))
