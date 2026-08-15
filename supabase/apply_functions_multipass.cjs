// One-off: applies 0004_functions.sql function-by-function against the
// linked Supabase project via the Management API, retrying functions that
// fail with "does not exist" (42883 - a forward reference to a function
// defined later in file order) across multiple passes until stable. Needed
// because LANGUAGE sql functions validate references at CREATE time (unlike
// plpgsql, which defers), and the source export is alphabetically ordered,
// not dependency-ordered. Read-only except for the CREATE OR REPLACE
// FUNCTION statements themselves (idempotent, safe to retry).
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = 'slrtjxtzhowhwhebjprv';
if (!TOKEN) { console.error('SUPABASE_ACCESS_TOKEN not set'); process.exit(1); }

const src = fs.readFileSync(path.join(__dirname, 'migrations', '0004_functions.sql'), 'utf8');
const lines = src.split('\n');

const blocks = [];
let current = null;
for (const line of lines) {
  if (/^-- Function: /.test(line)) {
    if (current) blocks.push(current);
    current = { name: line.replace('-- Function: ', '').trim(), sql: [] };
  } else if (current) {
    current.sql.push(line);
  }
}
if (current) blocks.push(current);

console.log(`Parsed ${blocks.length} function blocks.`);

async function runSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  let pending = blocks.map(b => ({ ...b, text: b.sql.join('\n').trim() })).filter(b => b.text.length > 0);
  let pass = 1;
  const errors = [];
  while (pending.length > 0 && pass <= 8) {
    console.log(`\n--- Pass ${pass}: ${pending.length} remaining ---`);
    const stillPending = [];
    for (const b of pending) {
      const r = await runSql(b.text);
      if (!r.ok) {
        const msg = JSON.stringify(r.body);
        // 42883 = undefined function/does-not-exist -> likely a forward reference, retry later
        if (msg.includes('42883') || /does not exist/i.test(msg)) {
          stillPending.push(b);
        } else {
          errors.push({ name: b.name, error: msg });
          console.log(`  FAIL (non-ordering) ${b.name}: ${msg.slice(0, 200)}`);
        }
      }
    }
    if (stillPending.length === pending.length) {
      // no progress this pass -> real problem, not just ordering
      console.log(`  No progress this pass. Remaining stuck: ${stillPending.map(b => b.name).join(', ')}`);
      for (const b of stillPending) errors.push({ name: b.name, error: 'stuck after no-progress pass' });
      pending = [];
      break;
    }
    console.log(`  Resolved ${pending.length - stillPending.length} this pass.`);
    pending = stillPending;
    pass++;
  }
  if (pending.length > 0) {
    console.log(`\nStill pending after max passes: ${pending.map(b => b.name).join(', ')}`);
    for (const b of pending) errors.push({ name: b.name, error: 'exceeded max passes' });
  }
  console.log(`\n=== DONE. ${blocks.length - errors.length}/${blocks.length} functions created. ${errors.length} errors. ===`);
  if (errors.length > 0) {
    fs.writeFileSync(path.join(__dirname, '_function_apply_errors.json'), JSON.stringify(errors, null, 2));
    console.log('Errors written to _function_apply_errors.json');
    process.exitCode = 1;
  }
}

main();
