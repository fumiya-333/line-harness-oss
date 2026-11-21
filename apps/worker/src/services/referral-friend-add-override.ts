import { getEntryRouteByRefCode, jstNow } from '@line-crm/db';

/**
 * How far back a friend_add enrollment counts as "just started" when the
 * referral is recorded after the follow webhook already enrolled the friend.
 *
 * The race this covers: a first-time friend opens a referral link in the LINE
 * app, adds the account, and only comes back to the LIFF page afterwards. The
 * follow webhook waits ~1s for friends.ref_code, gives up, and enrolls the
 * account friend_add scenarios. The LIFF page then re-posts /api/liff/link
 * (client/main.ts, visibilitychange) and the ref is recorded — after the
 * enrollment. 30 minutes leaves room for a slow return to the LIFF page while
 * keeping long-standing friends' sequences out of reach.
 */
export const REFERRAL_OVERRIDE_WINDOW_MINUTES = 30;

/**
 * Stop account friend_add enrollments that the follow webhook started just
 * before the friend's referral (ref_code) was recorded, when that referral's
 * entry route opts out of account friend_add scenarios
 * (entry_routes.run_account_friend_add_scenarios = 0).
 *
 * Call only right after the first-touch `UPDATE friends SET ref_code = ?
 * WHERE ... AND ref_code IS NULL` actually changed the row, i.e. when this ref
 * became the friend's recorded source.
 *
 * Only rows that are still waiting for their first step are stopped
 * (status 'active', current_step_order -1). A step that already went out
 * (e.g. the instant welcome sent by reply in the follow webhook) cannot be
 * recalled, and those enrollments are left as they are. tag_added and other
 * trigger types (e.g. a scenario started by the route's own tag) are never
 * touched. Stopped rows become 'paused', the same state the step delivery
 * uses for deliveries it stops, so the admin UI still shows the enrollment.
 *
 * Returns the number of enrollments stopped.
 */
export async function stopFriendAddEnrollmentsForReferral(
  db: D1Database,
  friendId: string,
  refCode: string,
  options?: { now?: Date },
): Promise<number> {
  const route = await getEntryRouteByRefCode(db, refCode);
  if (!route || route.run_account_friend_add_scenarios !== 0) return 0;

  const rows = await db
    .prepare(
      `SELECT fs.id, fs.started_at FROM friend_scenarios fs
       INNER JOIN scenarios s ON fs.scenario_id = s.id
       WHERE fs.friend_id = ?
         AND s.trigger_type = 'friend_add'
         AND fs.status = 'active'
         AND fs.current_step_order = -1`,
    )
    .bind(friendId)
    .all<{ id: string; started_at: string }>();

  const nowMs = (options?.now ?? new Date()).getTime();
  const thresholdMs = nowMs - REFERRAL_OVERRIDE_WINDOW_MINUTES * 60_000;
  let stopped = 0;
  for (const row of rows.results) {
    const startedMs = parseStartedAt(row.started_at);
    if (!Number.isFinite(startedMs) || startedMs < thresholdMs) continue;
    const result = await db
      .prepare(
        `UPDATE friend_scenarios SET status = 'paused', updated_at = ?
         WHERE id = ? AND status = 'active' AND current_step_order = -1`,
      )
      .bind(jstNow(), row.id)
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      stopped++;
      console.log(
        `[referral-override] paused friend_add enrollment=${row.id} friend=${friendId} route=${route.id}`,
      );
    }
  }
  return stopped;
}

// started_at is written by jstNow() ('...+09:00'); older rows may carry 'Z',
// and the column DEFAULT writes JST wall-clock time with no offset. Read an
// offset-less value as JST so it is not shifted by the runtime's zone.
function parseStartedAt(value: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return new Date(hasZone ? value : `${value.replace(' ', 'T')}+09:00`).getTime();
}
