#!/usr/bin/env python3
"""Fidelity check for the local test harnesses.

For each named function, compares the definition in a local test schema file
with the LATEST definition of that function in supabase/migrations (the last
migration, in file order, that contains `CREATE OR REPLACE FUNCTION
public.<name>(`). Trailing whitespace is ignored; nothing else is.

Usage: check-verbatim-functions.py [--before NNNN] <repo_root> <schema_file> <name> [<name> ...]
--before NNNN only considers migrations numbered below NNNN (a copy of a
function as it was BEFORE that migration replaced it).
Prints one line per function ("same <name> <- <migration>" or "DIFFERS ...")
and exits 1 if any copy differs from, or is missing in, either side.
Reads files only; never touches a database.
"""
import glob
import os
import re
import sys


def last_definition(text, name):
    matches = list(re.finditer(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(', text))
    if not matches:
        return None
    start = matches[-1].start()
    m = re.search(r'AS (\$[A-Za-z_]*\$)', text[start:])
    if not m:
        return None
    body_start = start + m.end()
    end = text.index(m.group(1), body_start) + len(m.group(1))
    return '\n'.join(line.rstrip() for line in text[start:end].splitlines())


def main():
    args = sys.argv[1:]
    before = None
    if args[:1] == ['--before']:
        before, args = args[1], args[2:]
    root, schema_file, names = args[0], args[1], args[2:]
    copy_text = open(schema_file, encoding='utf-8').read()
    migrations = sorted(glob.glob(os.path.join(root, 'supabase', 'migrations', '*.sql')))
    if before is not None:
        migrations = [m for m in migrations if os.path.basename(m)[:4] < before]
    bad = 0
    for name in names:
        source = None
        for path in migrations:
            d = last_definition(open(path, encoding='utf-8').read(), name)
            if d is not None:
                source = (os.path.basename(path), d)
        copy = last_definition(copy_text, name)
        if source is None or copy is None:
            print(f'MISSING {name} (in {"migrations" if source is None else os.path.basename(schema_file)})')
            bad += 1
        elif source[1] == copy:
            print(f'same {name} <- {source[0]}')
        else:
            print(f'DIFFERS {name} <- {source[0]}')
            bad += 1
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
