import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// Regression guard for the private Chats Realtime leak (migration 0199):
// notify_new_direct_message() broadcast every DM body on the PUBLIC topic
// 'user:<recipient>', and clients joined other users' personal topics to
// send typing indicators. Static: replays the migrations for each trigger
// function's latest definition, checks 0199's policies, and scans the app
// source for how Realtime channels are opened. Real execution against
// Postgres lives in scripts/local-pg-test/run-private-realtime-verification.sh.

const root = join(__dirname, '..', '..');
const migDir = join(root, 'supabase', 'migrations');
const migrations = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
const m0199 = readFileSync(join(migDir, '0199_private_realtime_user_and_dm_topics.sql'), 'utf8');

function latestDefinition(fn: string): { file: string; body: string } {
  let latest: { file: string; body: string } | undefined;
  const re = new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${fn}\\(\\)[\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$`, 'g');
  for (const file of migrations) {
    for (const m of readFileSync(join(migDir, file), 'utf8').matchAll(re)) latest = { file, body: m[1] };
  }
  if (!latest) throw new Error(`${fn} not found`);
  return latest;
}

function policy(name: string): string {
  const m = m0199.match(new RegExp(`CREATE POLICY ${name} ON realtime\\.messages[\\s\\S]*?\\);`));
  if (!m) throw new Error(`policy ${name} not found`);
  return m[0];
}

describe('database: broadcasts are private and carry no message body', () => {
  it('notify_new_direct_message (latest: 0199) sends a body-less, private new_message', () => {
    const { file, body } = latestDefinition('notify_new_direct_message');
    expect(file).toBe('0199_private_realtime_user_and_dm_topics.sql');
    expect(body).not.toMatch(/'body'|NEW\.body/);
    expect(body).toMatch(/'new_message',\s*'user:' \|\| NEW\.recipient_id::text,\s*true\s*\)/);
  });

  it('notify_new_notification (latest: 0199) sends privately', () => {
    const { file, body } = latestDefinition('notify_new_notification');
    expect(file).toBe('0199_private_realtime_user_and_dm_topics.sql');
    expect(body).toMatch(/'new_notification',\s*'user:' \|\| NEW\.user_id::text,\s*true\s*\)/);
  });

  it('notify_vc_update (latest: 0199) sends privately to the same user:<uid> topic', () => {
    const { file, body } = latestDefinition('notify_vc_update');
    expect(file).toBe('0199_private_realtime_user_and_dm_topics.sql');
    expect(body).toMatch(/'vc_updated',\s*'user:' \|\| NEW\.user_id::text,\s*true\s*\)/);
  });

  it('no function in the latest migrations publishes to a user: topic publicly', () => {
    const latest = new Map<string, string>();
    const re = /CREATE OR REPLACE FUNCTION (?:public\.)?(\w+)\([\s\S]*?\$function\$([\s\S]*?)\$function\$/g;
    for (const f of migrations) for (const m of readFileSync(join(migDir, f), 'utf8').matchAll(re)) latest.set(m[1], m[2]);
    const publicUserSends = [...latest].filter(([, body]) => /realtime\.send\([\s\S]*?'user:'[\s\S]*?,\s*false\s*\)/.test(body)).map(([fn]) => fn);
    expect(publicUserSends).toEqual([]);
  });

  it('no migration after 0199 re-publishes a DM body to Realtime', () => {
    const later = migrations.filter((f) => f > '0199');
    for (const f of later) {
      const sql = readFileSync(join(migDir, f), 'utf8');
      expect(sql, f).not.toMatch(/realtime\.send\([\s\S]*?NEW\.body/);
    }
  });
});

describe('database: realtime.messages policies (0199)', () => {
  it('defines exactly the receive and send policies, both for authenticated only', () => {
    const names = [...m0199.matchAll(/CREATE POLICY (\w+) ON realtime\.messages/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(['vents_private_topics_receive', 'vents_private_topics_send']);
    expect(policy('vents_private_topics_receive')).toMatch(/FOR SELECT TO authenticated/);
    expect(policy('vents_private_topics_send')).toMatch(/FOR INSERT TO authenticated/);
    expect(m0199).not.toMatch(/ON realtime\.messages[\s\S]{0,40}TO (anon|public)\b/i);
  });

  it('receive: only your own user:<uid> topic, or a dm topic you are a participant in', () => {
    const p = policy('vents_private_topics_receive');
    expect(p).toMatch(/\(SELECT realtime\.topic\(\)\) = 'user:' \|\| \(SELECT auth\.uid\(\)\)::text/);
    expect(p).toMatch(/public\.can_access_dm_realtime_topic\(\(SELECT realtime\.topic\(\)\)\)/);
    expect(p).toMatch(/extension = 'broadcast'/);
  });

  it('send: dm topics only -- nothing lets a client broadcast into a user:<uid> topic', () => {
    const p = policy('vents_private_topics_send');
    expect(p).not.toMatch(/user:/);
    expect(p).toMatch(/public\.can_access_dm_realtime_topic\(\(SELECT realtime\.topic\(\)\)\)/);
  });

  it('the dm helper is SECURITY DEFINER, empty search_path, blocked both ways, not callable by anon', () => {
    const fn = m0199.match(/FUNCTION public\.can_access_dm_realtime_topic[\s\S]*?\$function\$;/)![0];
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path TO ''/);
    expect(fn).toMatch(/blocker_id = v_uid AND blocked_id = v_other/);
    expect(fn).toMatch(/blocker_id = v_other AND blocked_id = v_uid/);
    expect(m0199).toMatch(/REVOKE ALL ON FUNCTION public\.can_access_dm_realtime_topic\(text\) FROM PUBLIC, anon;/);
  });
});

describe('app source: Realtime channels for user and dm topics', () => {
  const srcFiles: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) srcFiles.push(p);
    }
  };
  walk(join(root, 'src'));
  const channelCalls = srcFiles.flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/supabase\.channel\(([^;]*?)\);/g)].map((m) => ({ file: relative(root, f), call: m[1] })),
  );

  it('never builds a user: or dm: topic by hand -- always userTopic()/dmTopic()', () => {
    const raw = channelCalls.filter((c) => /[`'"](user|dm):/.test(c.call));
    expect(raw).toEqual([]);
  });

  it('every user/dm channel is opened as a private channel', () => {
    const personal = channelCalls.filter((c) => /userTopic\(|dmTopic\(/.test(c.call));
    expect(personal.length).toBeGreaterThanOrEqual(4); // App, Notifications, Conversation (user + dm)
    for (const c of personal) expect(c.call, c.file).toMatch(/PRIVATE_CHANNEL_OPTIONS/);
  });

  it('only ever joins the signed-in user\'s own personal topic', () => {
    for (const c of channelCalls.filter((x) => /userTopic\(/.test(x.call))) {
      expect(c.call, c.file).toMatch(/userTopic\(currentUser\.id\)/);
    }
  });
});
