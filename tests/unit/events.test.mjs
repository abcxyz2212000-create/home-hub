import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toDayNumber, todayJST, cardExpiryDate, nextAnnualFeeDate, resolveOffsets, collectEvents, upcomingEvents,
  dueNotifications, monthlyTotal, notificationText,
} from '../../web/js/events.js';

test('date helpers', () => {
  assert.equal(toDayNumber('1970-01-02'), 1);
  assert.equal(toDayNumber('2026-02-30'), null);
  assert.equal(toDayNumber('bad'), null);
  // 2026-10-31 15:30 UTC is already 2026-11-01 in Japan
  assert.equal(todayJST(new Date('2026-10-31T15:30:00Z')), '2026-11-01');
  assert.equal(todayJST(new Date('2026-10-31T14:59:00Z')), '2026-10-31');
  assert.equal(cardExpiryDate('2028-02'), '2028-02-29');
  assert.equal(cardExpiryDate('2027-13'), null);
  assert.equal(nextAnnualFeeDate(12, '2026-10-31'), '2026-12-01');
  assert.equal(nextAnnualFeeDate(10, '2026-10-31'), '2027-10-01');
  assert.equal(nextAnnualFeeDate(11, '2026-11-01'), '2026-11-01');
});

test('offsets: defaults, overrides and disabling', () => {
  assert.deepEqual(resolveOffsets({}, 'contract_renewal'), [30, 7]);
  assert.deepEqual(resolveOffsets({ notify_days: { contract_renewal: [7, 60] } }, 'contract_renewal'), [60, 7]);
  assert.deepEqual(resolveOffsets({ notify_days: { contract_renewal: [] } }, 'contract_renewal'), []);
});

const data = {
  cards: [
    { id: 'c1', name: 'カードA', status: 'active', expiry_ym: '2026-11', annual_fee: 1100, annual_fee_month: 12, notify_days: {} },
    { id: 'c2', name: 'カードB', status: 'closed', expiry_ym: '2026-11', notify_days: {} },
    { id: 'c3', name: 'カードC', status: 'active', annual_fee: 0, annual_fee_month: 12, notify_days: {} },
  ],
  contracts: [
    { id: 'k1', name: '保険', status: 'active', auto_renew: true, renewal_date: '2026-11-07', notify_days: {} },
    { id: 'k2', name: '手動更新', status: 'active', auto_renew: false, renewal_date: '2026-11-07', notify_days: {} },
  ],
  items: [{ id: 'i1', name: '冷蔵庫', status: 'active', warranty_until: '2026-10-01', notify_days: {} }],
};

test('collectEvents skips closed, non-auto-renew and free cards', () => {
  const ev = collectEvents(data, '2026-10-31');
  assert.deepEqual(ev.map((e) => `${e.type}:${e.id}:${e.daysLeft}`), [
    'warranty:i1:-30', 'contract_renewal:k1:7', 'card_expiry:c1:30', 'annual_fee:c1:31',
  ]);
  assert.equal(upcomingEvents(ev).length, 4);
});

test('dueNotifications picks the current stage once', () => {
  const ev = collectEvents(data, '2026-10-31');
  const due = dueNotifications(ev);
  assert.deepEqual(due.map((d) => d.key), [
    'contract_renewal:k1:2026-11-07:7', // 30-day stage is superseded by the 7-day stage
    'card_expiry:c1:2026-11-30:30',
  ]);
  // a day later the card is still due at stage 30 (caught up if the run was missed)
  const later = dueNotifications(collectEvents(data, '2026-11-01'));
  assert.ok(later.some((d) => d.key === 'card_expiry:c1:2026-11-30:30'));
  assert.ok(later.some((d) => d.key === 'annual_fee:c1:2026-12-01:30'));
});

test('notification text and monthly total', () => {
  const [e] = collectEvents({ items: [{ id: 'x', name: 'テレビ', status: 'active', warranty_until: '2026-10-31' }] }, '2026-10-31');
  assert.match(notificationText(e).body, /^今日（2026-10-31）/);
  assert.equal(monthlyTotal([
    { status: 'active', amount: 1000, cycle: 'monthly' },
    { status: 'active', amount: 12000, cycle: 'yearly' },
    { status: 'closed', amount: 5000, cycle: 'monthly' },
    { status: 'active', amount: null, cycle: 'monthly' },
  ]), 2000);
});
