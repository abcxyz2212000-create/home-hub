import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageClassOf, lookups, lookupText, surveyYearFor, reiwa, overviewUrl } from '../../web/js/wage.js';
import { percents } from '../../web/js/budget.js';
import { reminderText } from '../../scripts/wage.mjs';

test('age group in the budget year', () => {
  assert.equal(ageClassOf(1993, 2026), '30～34歳');
  assert.equal(ageClassOf(1990, 2026), '35～39歳');
  assert.equal(ageClassOf(2009, 2026), '～19歳');
  assert.equal(ageClassOf(2015, 2026), null, 'too young to be a worker in the table');
  assert.equal(ageClassOf(1950, 2026), '70歳～');
  assert.equal(ageClassOf(null, 2026), null);
  assert.equal(surveyYearFor(2026), 2024);
  assert.equal(reiwa(2024), '令和6年');
  assert.equal(overviewUrl(2024), 'https://www.mhlw.go.jp/toukei/itiran/roudou/chingin/kouzou/z2024/index.html');
});

test('what to look up for each person, or what is missing', () => {
  const members = [{ id: 'a', nickname: 'しん', gender: 'male', birth_year: 1990 }, { id: 'b', nickname: 'はる', gender: 'female', birth_year: 1990 }];
  const { items, problems } = lookups(members, 2026);
  assert.deepEqual(items.map((it) => lookupText(2024, it)), ['令和6年 男 35～39歳', '令和6年 女 35～39歳']);
  assert.deepEqual(problems, []);
  assert.deepEqual(lookups([{ id: 'c', nickname: 'x', birth_year: 1990 }], 2026).problems, ['xの性別がユーザーマスターにありません。']);
  assert.deepEqual(lookups([{ id: 'c', nickname: 'x', gender: 'male' }], 2026).problems, ['xの生まれ年がユーザーマスターにありません。']);
  const pc = percents({ a: 294.6, b: 258.1 }, ['a', 'b']);
  assert.deepEqual([pc.get('a'), pc.get('b')], [53, 47]);
});

test('the December reminder says what to look up', () => {
  const members = [{ id: 'a', nickname: 'しん', gender: 'male', birth_year: 1990 }, { id: 'b', nickname: 'はる', gender: 'female', birth_year: 1990 }];
  const r = reminderText(2027, members);
  assert.equal(r.title, '来年の負担率の確認');
  assert.equal(r.body, '2027年の負担率を決めてください。令和7年の賃金統計（第6-1表 正社員・正職員）で しん 男 35～39歳・はる 女 35～39歳 の賃金を見て、負担率の編集画面に入れます。');
  assert.equal(r.url, '#/ratio/2027');
  assert.match(reminderText(2027, [{ ...members[0], birth_year: null }]).body, /しんの生まれ年がユーザーマスターにありません。$/);
});
