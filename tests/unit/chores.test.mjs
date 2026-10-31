import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyHours, basePoints, adjustedPoints, workload, isDueOn, dueFor, timesPerCycle, scheduleText } from '../../web/js/chores.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('same formulas as the spreadsheet (h/月, 評価/月, 調整後評価/月)', () => {
  // week, 2 times, 5 min, adjust 1.1  -> 0.6667 h, 666.67, 733.33
  const a = { cycle: 'week', times: 2, minutes: 5, adjust: 1.1 };
  close(monthlyHours(a), 2 * 5 * 4 / 60);
  close(basePoints(a), 666.6666666666666);
  close(adjustedPoints(a), 733.3333333333333);
  // year, once, 20 min -> 0.02778 h
  close(monthlyHours({ cycle: 'year', times: 1, minutes: 20, adjust: 1 }), 0.027777777777777776);
  // month, twice, 15 min, adjust 1.1 -> 550
  close(adjustedPoints({ cycle: 'month', times: 2, minutes: 15, adjust: 1.1 }), 550);
  // day, once, 2 min -> 1 h
  close(monthlyHours({ cycle: 'day', times: 1, minutes: 2 }), 1);
  // ad hoc: points are entered directly
  assert.equal(monthlyHours({ cycle: 'adhoc', points_override: 500 }), null);
  close(adjustedPoints({ cycle: 'adhoc', points_override: 500, adjust: 0.8 }), 400);
});

test('chosen days decide the number of times', () => {
  assert.equal(timesPerCycle({ cycle: 'week', schedule: [2, 5], times: 9 }), 2);
  assert.equal(timesPerCycle({ cycle: 'week', schedule: [], times: 3 }), 3);
  assert.equal(scheduleText({ cycle: 'week', schedule: [5, 2] }), '毎週 火・金');
  assert.equal(scheduleText({ cycle: 'month', schedule: [], times: 2 }), '月2回（やる日は未設定）');
});

test('workload: per member, "all" split equally, "tbd" separate', () => {
  const members = [
    { id: 's', name: '佐藤 真一', nickname: 'しん', active: true },
    { id: 'h', name: '佐藤 春子', nickname: 'はる', active: true },
    { id: 'x', name: '共通（管理者）', active: true },
  ];
  const chores = [
    { cycle: 'week', times: 2, minutes: 5, adjust: 1.1, assignee_type: 'member', assignee_id: 's', category: '住' }, // 733.33
    { cycle: 'month', times: 2, minutes: 15, adjust: 1.1, assignee_type: 'member', assignee_id: 'h', category: '食' }, // 550
    { cycle: 'month', times: 1, minutes: 60, adjust: 1, assignee_type: 'all', category: '衣' }, // 1000 -> 500 each
    { cycle: 'adhoc', points_override: 300, adjust: 1, assignee_type: 'tbd' },
    { cycle: 'week', times: 7, minutes: 60, adjust: 1, assignee_type: 'member', assignee_id: 's', status: 'closed' },
  ];
  const w = workload(chores, members);
  const by = Object.fromEntries(w.rows.map((r) => [r.member.nickname, r]));
  assert.deepEqual(Object.keys(by).sort(), ['しん', 'はる'], 'the shared admin account is not a sharer');
  close(by['しん'].points, 733.3333333333333 + 500);
  close(by['はる'].points, 550 + 500);
  close(by['しん'].byCategory['衣'], 500);
  close(w.tbd.points, 300);
});

test('due dates', () => {
  // 2026-11-03 is a Tuesday; 2026-11-30 is the last day of November
  const weekly = { cycle: 'week', schedule: [2, 5], assignee_type: 'member', assignee_id: 's' };
  assert.equal(isDueOn(weekly, '2026-11-03'), true);
  assert.equal(isDueOn(weekly, '2026-11-04'), false);
  assert.equal(isDueOn({ cycle: 'month', schedule: [31] }, '2026-11-30'), true, '31st falls on the last day');
  assert.equal(isDueOn({ cycle: 'month', schedule: [15] }, '2026-11-15'), true);
  assert.equal(isDueOn({ cycle: 'year', schedule: [12] }, '2026-12-01'), true);
  assert.equal(isDueOn({ cycle: 'year', schedule: [12] }, '2026-12-02'), false);
  assert.equal(isDueOn({ cycle: 'day' }, '2026-11-04'), true);
  assert.equal(isDueOn({ cycle: 'week', schedule: [] }, '2026-11-03'), false, 'no days -> no reminder');
  assert.equal(isDueOn({ cycle: 'day', status: 'closed' }, '2026-11-03'), false);
  const chores = [weekly, { cycle: 'day', assignee_type: 'all' }, { cycle: 'day', assignee_type: 'member', assignee_id: 'h' }, { cycle: 'day', assignee_type: 'tbd' }];
  assert.equal(dueFor(chores, '2026-11-03', 's').length, 2);
  assert.equal(dueFor(chores, '2026-11-03', 'h').length, 2);
});
