import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageClassOf, lookups, parseEstat, buildProposal, surveyYearFor, sourceText, reiwa, chooseClasses, narrowParams, metaClasses } from '../../web/js/wage.js';
import { percents } from '../../web/js/budget.js';
import { fetchWages, candidateTables } from '../../scripts/wage.mjs';

// Shaped like e-Stat getStatsData (made-up numbers): time x area x sex x age x measure.
function fixture() {
  const CLASS_OBJ = [
    { '@id': 'tab', '@name': '表章項目', CLASS: [{ '@code': '01', '@name': '所定内給与額' }, { '@code': '02', '@name': '年間賞与その他特別給与額' }] },
    { '@id': 'cat01', '@name': '性別', CLASS: [{ '@code': '1', '@name': '男女計' }, { '@code': '2', '@name': '男' }, { '@code': '3', '@name': '女' }] },
    { '@id': 'cat02', '@name': '年齢階級', CLASS: [
      { '@code': '00', '@name': '年齢計' }, { '@code': '01', '@name': '～19歳' }, { '@code': '02', '@name': '20～24歳' },
      { '@code': '03', '@name': '25～29歳' }, { '@code': '04', '@name': '30～34歳' }, { '@code': '05', '@name': '35～39歳' }, { '@code': '12', '@name': '70歳～' }] },
    { '@id': 'area', '@name': '地域', CLASS: [{ '@code': '00000', '@name': '全国' }, { '@code': '13000', '@name': '東京都' }] },
    { '@id': 'time', '@name': '時間軸（年次）', CLASS: [{ '@code': '2023000000', '@name': '2023年' }, { '@code': '2024000000', '@name': '2024年' }] },
  ];
  const VALUE = [];
  const put = (time, area, sex, age, tab, v) => VALUE.push({ '@tab': tab, '@cat01': sex, '@cat02': age, '@area': area, '@time': time, $: String(v) });
  put('2024000000', '00000', '2', '04', '01', '294.6');
  put('2024000000', '00000', '3', '03', '01', '258.1');
  put('2024000000', '00000', '3', '04', '01', '270.0');
  put('2024000000', '00000', '2', '04', '02', '900.0'); // bonus: not used
  put('2024000000', '13000', '2', '04', '01', '350.0'); // Tokyo: not used
  put('2023000000', '00000', '2', '04', '01', '290.0'); // other year: not used
  return { GET_STATS_DATA: { RESULT: { STATUS: 0 }, STATISTICAL_DATA: { CLASS_INF: { CLASS_OBJ }, DATA_INF: { VALUE } } } };
}

test('age group in the budget year', () => {
  assert.equal(ageClassOf(1993, 2026), '30～34歳');
  assert.equal(ageClassOf(1997, 2026), '25～29歳');
  assert.equal(ageClassOf(2009, 2026), '～19歳');
  assert.equal(ageClassOf(2015, 2026), null, 'too young to be a worker in the table');
  assert.equal(ageClassOf(1950, 2026), '70歳～');
  assert.equal(ageClassOf(null, 2026), null);
  assert.equal(surveyYearFor(2026), 2024);
  assert.equal(reiwa(2024), '令和6年');
});

test('e-Stat table: the year, 全国, 所定内給与額 by sex and age group', () => {
  const rows = parseEstat(fixture(), 2024);
  assert.deepEqual(rows.sort((a, b) => a.value - b.value), [
    { sex: 'female', ageClass: '25～29歳', value: 258.1 },
    { sex: 'female', ageClass: '30～34歳', value: 270 },
    { sex: 'male', ageClass: '30～34歳', value: 294.6 },
  ]);
  assert.throws(() => parseEstat(fixture(), 2020), /year 2020/);
  assert.throws(() => parseEstat({ GET_STATS_DATA: { RESULT: { STATUS: 100, ERROR_MSG: 'bad appId' } } }, 2024), /status 100/);
});

test('proposal: each person by sex and age, or what is missing', () => {
  const members = [{ id: 'a', nickname: 'しん', gender: 'male', birth_year: 1993 }, { id: 'b', nickname: 'はる', gender: 'female', birth_year: 1997 }];
  const p = buildProposal({ budgetYear: 2026, members, table: parseEstat(fixture(), 2024) });
  assert.equal(p.error, undefined);
  assert.deepEqual(p.values.map((v) => [v.member_id, v.value]), [['a', 294.6], ['b', 258.1]]);
  const pc = percents(Object.fromEntries(p.values.map((v) => [v.member_id, v.value])), ['a', 'b']);
  assert.deepEqual([pc.get('a'), pc.get('b')], [53, 47]);
  assert.equal(sourceText(p, p.values[0]), '令和6年 男 30～34歳 294.6千円');
  const noYear = buildProposal({ budgetYear: 2026, members: [members[0], { ...members[1], birth_year: null }], table: [] });
  assert.ok(noYear.error);
  assert.deepEqual(noYear.problems, ['はるの生まれ年がユーザーマスターにありません。']);
  assert.deepEqual(lookups([{ id: 'c', nickname: 'x', birth_year: 1990 }], 2026).problems, ['xの性別がユーザーマスターにありません。']);
  const failed = buildProposal({ budgetYear: 2026, members, error: 'HTTP 403' });
  assert.equal(failed.error, 'HTTP 403');
});

test('narrowing the query to the chosen classes', () => {
  const objs = fixture().GET_STATS_DATA.STATISTICAL_DATA.CLASS_INF.CLASS_OBJ;
  const c = chooseClasses(objs, 2024);
  assert.deepEqual(narrowParams(c.fixed), { cdTab: '01', cdArea: '00000', cdTime: '2024000000' });
  assert.equal(metaClasses({ GET_META_INFO: { RESULT: { STATUS: 0 }, METADATA_INF: { CLASS_INF: { CLASS_OBJ: objs } } } }).length, 5);
});

test('the yearly script asks e-Stat for the classes it needs only, the app ID never in errors', async () => {
  const objs = fixture().GET_STATS_DATA.STATISTICAL_DATA.CLASS_INF.CLASS_OBJ;
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    const u = new URL(url);
    if (u.pathname.endsWith('/getMetaInfo')) return new Response(JSON.stringify({ GET_META_INFO: { RESULT: { STATUS: 0 }, METADATA_INF: { CLASS_INF: { CLASS_OBJ: objs } } } }));
    return new Response(JSON.stringify(fixture()));
  };
  try {
    const { rows, source } = await fetchWages(2024, 'secret-app-id');
    assert.equal(rows.length, 3);
    assert.equal(source.id, '0003426933');
    const q = calls[1].searchParams;
    assert.deepEqual([q.get('cdTime'), q.get('cdArea'), q.get('cdTab'), q.get('statsDataId')], ['2024000000', '00000', '01', '0003426933']);
    globalThis.fetch = async () => new Response('no', { status: 403 });
    await assert.rejects(fetchWages(2024, 'secret-app-id'), (e) => /HTTP 403/.test(e.message) && !e.message.includes('secret-app-id'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('the year is found however the table writes it, and the error tells which years there are', () => {
  const objs = (names) => [
    { '@id': 'tab', '@name': '表章項目', CLASS: [{ '@code': '01', '@name': '所定内給与額' }] },
    { '@id': 'cat01', '@name': '性別', CLASS: [{ '@code': '2', '@name': '男' }, { '@code': '3', '@name': '女' }] },
    { '@id': 'cat02', '@name': '年齢階級', CLASS: ['20～24歳', '25～29歳', '30～34歳', '35～39歳', '40～44歳'].map((n, i) => ({ '@code': String(i), '@name': n })) },
    { '@id': 'time', '@name': '時間軸（年次）', CLASS: names },
  ];
  assert.equal(chooseClasses(objs([{ '@code': 'a', '@name': '令和6年' }]), 2024).fixed.time, 'a');
  assert.equal(chooseClasses(objs([{ '@code': 'b', '@name': '２０２４年' }]), 2024).fixed.time, 'b');
  assert.equal(chooseClasses(objs([{ '@code': '2024000000', '@name': '?' }]), 2024).fixed.time, '2024000000');
  assert.throws(() => chooseClasses(objs([{ '@code': '2023000000', '@name': '2023年' }]), 2024), /it has: 2023000000=2023年/);
});

test('tables of the year: wages of 一般労働者 by sex and age first, other breakdowns left out', () => {
  const t = (id, name, title) => ({ '@id': id, STATISTICS_NAME: name, TITLE: { $: title } });
  const json = { GET_STATS_LIST: { RESULT: { STATUS: 0 }, DATALIST_INF: { TABLE_INF: [
    t('1', '賃金構造基本統計調査 令和6年 短時間労働者', '性、年齢階級別1時間当たり所定内給与額'),
    t('2', '賃金構造基本統計調査 令和6年 一般労働者 産業大分類', '年齢階級別きまって支給する現金給与額、所定内給与額及び年間賞与その他特別給与額（産業計）'),
    t('3', '賃金構造基本統計調査 令和6年 一般労働者 職種', '職種、年齢階級別'),
    t('4', '賃金構造基本統計調査 令和6年 一般労働者 都道府県', '年齢階級別'),
  ] } } };
  assert.deepEqual(candidateTables(json).map((x) => x.id), ['2']);
  assert.deepEqual(candidateTables({ GET_STATS_LIST: { RESULT: { STATUS: 1 } } }), []);
});

test('when the database lacks the year, the year\'s own tables are tried', async () => {
  const objs = fixture().GET_STATS_DATA.STATISTICAL_DATA.CLASS_INF.CLASS_OBJ;
  const old = objs.map((o) => (o['@id'] === 'time' ? { ...o, CLASS: [{ '@code': '2023000000', '@name': '2023年' }] } : o));
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const id = u.searchParams.get('statsDataId');
    if (u.pathname.endsWith('/getStatsList')) return new Response(JSON.stringify({ GET_STATS_LIST: { RESULT: { STATUS: 0 }, DATALIST_INF: { TABLE_INF: [{ '@id': 'Y24', STATISTICS_NAME: '一般労働者', TITLE: '性、年齢階級別（産業計）' }] } } }));
    if (u.pathname.endsWith('/getMetaInfo')) return new Response(JSON.stringify({ GET_META_INFO: { RESULT: { STATUS: 0 }, METADATA_INF: { CLASS_INF: { CLASS_OBJ: id === 'Y24' ? objs : old } } } }));
    return new Response(JSON.stringify(fixture()));
  };
  try {
    const { rows, source } = await fetchWages(2024, 'k');
    assert.equal(source.id, 'Y24');
    assert.equal(rows.length, 3);
  } finally {
    globalThis.fetch = orig;
  }
});
