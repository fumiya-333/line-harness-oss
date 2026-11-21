import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { liffRoutes } from './liff.js';
import {
  REFERRAL_OVERRIDE_WINDOW_MINUTES,
  stopFriendAddEnrollmentsForReferral,
} from '../services/referral-friend-add-override.js';

// A first-time friend who adds the account through a referral link inside the
// LINE app is enrolled in the account friend_add scenarios by the follow
// webhook (it waits ~1s for friends.ref_code and gives up), and the ref is
// recorded afterwards by the LIFF page's post-add /api/liff/link retry. When
// the route opts out of account friend_add scenarios
// (run_account_friend_add_scenarios = 0), recording the ref must stop the
// enrollments that were just started and have not sent anything yet.

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

afterEach(() => { vi.restoreAllMocks(); });

function jst(msAgo: number): string {
  return new Date(Date.now() + 9 * 3_600_000 - msAgo).toISOString().slice(0, -1) + '+09:00';
}

function setup(options: { runAccount: 0 | 1 } = { runAccount: 0 }) {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(schema);
  sqlite.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,login_channel_id)
    VALUES('acct','channel-acct','acct','synthetic-token','synthetic-secret','login-acct')`).run();
  sqlite.prepare(`INSERT INTO friends(id,line_user_id,line_account_id,display_name)
    VALUES('friend-1','U-synthetic','acct','Synthetic')`).run();
  sqlite.exec("INSERT INTO tags(id,name) VALUES('tag-note','流入_note')");

  function scenario(id: string, trigger: 'friend_add' | 'tag_added', delay: number, tag: string | null = null) {
    sqlite.prepare(`INSERT INTO scenarios(id,name,trigger_type,trigger_tag_id,line_account_id)
      VALUES(?,?,?,?,NULL)`).run(id, id, trigger, tag);
    sqlite.prepare(`INSERT INTO scenario_steps(id,scenario_id,step_order,delay_minutes,message_type,message_content)
      VALUES(?,?,0,?,'text','Synthetic step')`).run(`step-${id}`, id, delay);
  }
  // Account-wide greeting (sent instantly by the webhook) and the 7-day sequence.
  scenario('greeting', 'friend_add', 0);
  scenario('onboarding', 'friend_add', 1440);
  // The route's own greeting, started by its tag.
  scenario('note-greeting', 'tag_added', 0, 'tag-note');
  sqlite.prepare(`INSERT INTO entry_routes(id,ref_code,name,tag_id,run_account_friend_add_scenarios)
    VALUES('route-note','note','note','tag-note',?)`).run(options.runAccount);

  function enrollment(id: string, scenarioId: string, step: number, status: string, startedAt: string) {
    sqlite.prepare(`INSERT INTO friend_scenarios(id,friend_id,scenario_id,current_step_order,status,started_at,next_delivery_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, 'friend-1', scenarioId, step, status, startedAt, jst(-86_400_000), startedAt);
  }

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === 'https://api.line.me/oauth2/v2.1/verify') {
      return new Response(JSON.stringify({ sub: 'U-synthetic', name: 'Synthetic' }), { status: 200 });
    }
    throw new Error(`No real network allowed: ${url}`);
  });
  vi.spyOn(LineClient.prototype, 'request').mockResolvedValue({ data: {}, headers: new Headers() } as never);

  const app = new Hono();
  app.route('/', liffRoutes);
  async function link(ref: string) {
    const response = await app.request('/api/liff/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'synthetic-id-token', ref }),
    }, {
      DB: db, LINE_LOGIN_CHANNEL_ID: 'login-acct', LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-token',
      WORKER_URL: 'https://worker.example.com',
    }, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
  }
  function statuses() {
    return Object.fromEntries(
      (sqlite.prepare('SELECT scenario_id, status FROM friend_scenarios WHERE friend_id = ? ORDER BY scenario_id')
        .all('friend-1') as Array<{ scenario_id: string; status: string }>)
        .map((r) => [r.scenario_id, r.status]),
    );
  }
  return { db, sqlite, enrollment, link, statuses };
}

describe('recording a referral that opts out of account friend_add scenarios', () => {
  it('stops the 7-day enrollment the follow webhook just started, keeps the sent greeting, and starts the route greeting', async () => {
    const s = setup();
    try {
      // Webhook state right after follow: greeting step 0 already sent (advanced),
      // 7-day sequence waiting for its first step.
      s.enrollment('fs-greeting', 'greeting', 0, 'active', jst(5_000));
      s.enrollment('fs-onboarding', 'onboarding', -1, 'active', jst(5_000));

      await s.link('note');

      expect(s.sqlite.prepare("SELECT ref_code FROM friends WHERE id='friend-1'").get()).toEqual({ ref_code: 'note' });
      expect(s.statuses()).toEqual({
        greeting: 'active',
        onboarding: 'paused',
        'note-greeting': expect.any(String),
      });
      // The route's own tag_added greeting is not caught by the stop.
      expect(s.statuses()['note-greeting']).not.toBe('paused');
    } finally { s.sqlite.close(); }
  });

  it('leaves enrollments alone when the route keeps account friend_add scenarios', async () => {
    const s = setup({ runAccount: 1 });
    try {
      s.enrollment('fs-onboarding', 'onboarding', -1, 'active', jst(5_000));
      await s.link('note');
      expect(s.statuses().onboarding).toBe('active');
    } finally { s.sqlite.close(); }
  });

  it('does nothing when the friend already had a recorded source (first touch wins)', async () => {
    const s = setup();
    try {
      s.sqlite.prepare("UPDATE friends SET ref_code = 'youtube' WHERE id = 'friend-1'").run();
      s.enrollment('fs-onboarding', 'onboarding', -1, 'active', jst(5_000));
      await s.link('note');
      expect(s.statuses().onboarding).toBe('active');
    } finally { s.sqlite.close(); }
  });

  it('does not reach enrollments older than the window', async () => {
    const s = setup();
    try {
      s.enrollment('fs-onboarding', 'onboarding', -1, 'active',
        jst((REFERRAL_OVERRIDE_WINDOW_MINUTES + 1) * 60_000));
      await s.link('note');
      expect(s.statuses().onboarding).toBe('active');
    } finally { s.sqlite.close(); }
  });

  it('reads an offset-less started_at (column DEFAULT) as JST', async () => {
    const s = setup();
    try {
      const recent = jst(60_000).replace('+09:00', '');
      const old = jst((REFERRAL_OVERRIDE_WINDOW_MINUTES + 1) * 60_000).replace('+09:00', '');
      s.enrollment('fs-greeting', 'greeting', -1, 'active', old);
      s.enrollment('fs-onboarding', 'onboarding', -1, 'active', recent);
      const stopped = await stopFriendAddEnrollmentsForReferral(s.db, 'friend-1', 'note');
      expect(stopped).toBe(1);
      expect(s.statuses()).toEqual({ greeting: 'active', onboarding: 'paused' });
    } finally { s.sqlite.close(); }
  });

  it('ignores unknown refs', async () => {
    const s = setup();
    try {
      s.enrollment('fs-onboarding', 'onboarding', -1, 'active', jst(5_000));
      expect(await stopFriendAddEnrollmentsForReferral(s.db, 'friend-1', 'unknown')).toBe(0);
      expect(s.statuses().onboarding).toBe('active');
    } finally { s.sqlite.close(); }
  });
});
