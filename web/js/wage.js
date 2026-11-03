// The ratio of the two people from wage statistics (2026-11-03).
//
// 厚生労働省「賃金構造基本統計調査」: 一般労働者の性、年齢階級別の賃金（所定内給与額、千円）. For the budget of
// year Y the results of Y-2 are used (the household's rule: the previous year's results are not out
// in time). Each person's value is the one of their sex and of the age group they are in during Y.
// The numbers come from e-Stat (政府統計の総合窓口) by its API; parseEstat reads its JSON.

export const SURVEY_LAG = 2;
// e-Stat database 「賃金構造基本統計調査 令和２年以降 一般_都道府県別_年齢階級別DB」.
export const ESTAT_STATS_DATA_ID = '0003426933';
export const ESTAT_DB_URL = `https://www.e-stat.go.jp/dbview?sid=${ESTAT_STATS_DATA_ID}`;
export const AGE_CLASSES = ['～19歳', '20～24歳', '25～29歳', '30～34歳', '35～39歳', '40～44歳', '45～49歳', '50～54歳', '55～59歳', '60～64歳', '65～69歳', '70歳～'];
export const SEX_LABEL = { male: '男', female: '女' };

export function surveyYearFor(budgetYear) {
  return Number(budgetYear) - SURVEY_LAG;
}

// 令和 for years from 2019.
export function reiwa(year) {
  return `令和${Number(year) - 2018}年`;
}

export function overviewUrl(surveyYear) {
  return `https://www.mhlw.go.jp/toukei/itiran/roudou/chingin/kouzou/z${surveyYear}/index.html`;
}

// Age group of a person born in birthYear, during `year` (the age they reach that year).
export function ageClassOf(birthYear, year) {
  const by = Number(birthYear);
  if (!Number.isInteger(by)) return null;
  const age = Number(year) - by;
  if (age < 15 || age > 120) return null;
  if (age < 20) return AGE_CLASSES[0];
  if (age >= 70) return AGE_CLASSES[AGE_CLASSES.length - 1];
  return AGE_CLASSES[1 + Math.floor((age - 20) / 5)];
}

// What to look up for each person: [{ member_id, sex, ageClass }] and problems (Japanese, for the screen).
export function lookups(members, budgetYear) {
  const items = [];
  const problems = [];
  for (const m of members) {
    const name = m.nickname || m.name || '（名前なし）';
    const sex = m.gender === 'male' || m.gender === 'female' ? m.gender : null;
    const ageClass = ageClassOf(m.birth_year, budgetYear);
    if (!sex) problems.push(`${name}の性別がユーザーマスターにありません。`);
    if (!ageClass) problems.push(`${name}の生まれ年がユーザーマスターにありません。`);
    if (sex && ageClass) items.push({ member_id: m.id, sex, ageClass });
  }
  return { items, problems };
}

// Digits of an age group, to compare names written differently: '30～34歳', '30-34歳', '30～34' -> '30-34';
// '～19歳' -> '-19'; '70歳～' -> '70-'.
function ageKey(name) {
  const t = String(name).normalize('NFKC').replace(/[〜~～ー−-]/g, '-').replace(/[歳才\s]/g, '');
  const m = /^(\d*)-(\d*)$/.exec(t);
  return m ? `${m[1]}-${m[2]}` : null;
}

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// Which class of each dimension to use (e-Stat CLASS_OBJ list): the year, 全国 / totals, 所定内給与額; sex
// and age group are kept whole. Returns { fixed: { dim: code }, sexDim, ageDim, sexOf: Map, ageOf: Map }.
// Throws (English message) when the table does not look as expected.
export function chooseClasses(classObjs, surveyYear) {
  const fixed = {};
  let sexDim = null;
  let ageDim = null;
  const sexOf = new Map();
  const ageOf = new Map();
  for (const o of list(classObjs)) {
    const id = o['@id'];
    const name = String(o['@name'] || '');
    const classes = list(o.CLASS).map((c) => ({ code: c['@code'], name: String(c['@name'] || '') }));
    if (id === 'time' || /時間軸/.test(name)) {
      // '2024年', '２０２４年', '令和6年' or a code starting with the year
      const y = String(surveyYear);
      const hit = classes.find((c) => c.name.normalize('NFKC').replace(/\s/g, '').startsWith(`${y}年`))
        || classes.find((c) => c.name.normalize('NFKC').includes(reiwa(surveyYear)))
        || classes.find((c) => String(c.code).startsWith(y));
      if (!hit) throw new Error(`year ${surveyYear} is not in the table (it has: ${classes.slice(-6).map((c) => `${c.code}=${c.name}`).join(', ')})`);
      fixed[id] = hit.code;
    } else if (/性別/.test(name)) {
      sexDim = id;
      for (const c of classes) {
        if (/^男(性)?$/.test(c.name)) sexOf.set(c.code, 'male');
        if (/^女(性)?$/.test(c.name)) sexOf.set(c.code, 'female');
      }
    } else if (/年齢/.test(name)) {
      ageDim = id;
      const keys = new Map(AGE_CLASSES.map((a) => [ageKey(a), a]));
      for (const c of classes) {
        const a = keys.get(ageKey(c.name));
        if (a) ageOf.set(c.code, a);
      }
    } else if (id === 'tab' || /表章/.test(name)) {
      const hit = classes.find((c) => /所定内給与額/.test(c.name));
      if (!hit) throw new Error('no 所定内給与額 in the table');
      fixed[id] = hit.code;
    } else {
      // area, industry, company size, education ...: the total
      const hit = classes.find((c) => /^全国$/.test(c.name)) || classes.find((c) => /計/.test(c.name)) || classes[0];
      if (!hit) throw new Error(`dimension ${name} has no class`);
      fixed[id] = hit.code;
    }
  }
  if (!sexDim || !ageDim || sexOf.size < 2 || ageOf.size < 5) throw new Error('the table has no sex or age dimension');
  return { fixed, sexDim, ageDim, sexOf, ageOf };
}

// Query parameters that narrow getStatsData to the chosen classes: { cdTime: ..., cdArea: ..., cdCat01: ... }.
export function narrowParams(fixed) {
  return Object.fromEntries(Object.entries(fixed).map(([dim, code]) => [`cd${dim.charAt(0).toUpperCase()}${dim.slice(1)}`, code]));
}

function checkStatus(json, key) {
  const data = json && json[key];
  const status = data && data.RESULT ? Number(data.RESULT.STATUS) : null;
  if (status !== 0) throw new Error(`e-Stat returned status ${status}: ${data && data.RESULT ? data.RESULT.ERROR_MSG : 'no result'}`);
  return data;
}

// CLASS_OBJ of e-Stat getMetaInfo.
export function metaClasses(json) {
  const data = checkStatus(json, 'GET_META_INFO');
  return list(data.METADATA_INF && data.METADATA_INF.CLASS_INF && data.METADATA_INF.CLASS_INF.CLASS_OBJ);
}

// Reads the JSON of e-Stat getStatsData into [{ sex: 'male'|'female', ageClass, value }] for one year.
export function parseEstat(json, surveyYear) {
  const data = checkStatus(json, 'GET_STATS_DATA');
  const sd = data.STATISTICAL_DATA;
  const { fixed, sexDim, ageDim, sexOf, ageOf } = chooseClasses(sd && sd.CLASS_INF && sd.CLASS_INF.CLASS_OBJ, surveyYear);
  const out = [];
  for (const v of list(sd.DATA_INF && sd.DATA_INF.VALUE)) {
    if (!Object.entries(fixed).every(([dim, code]) => v[`@${dim}`] === code)) continue;
    const sex = sexOf.get(v[`@${sexDim}`]);
    const ageClass = ageOf.get(v[`@${ageDim}`]);
    const value = Number(String(v.$).replace(/,/g, ''));
    if (sex && ageClass && Number.isFinite(value) && value > 0) out.push({ sex, ageClass, value });
  }
  if (out.length === 0) throw new Error('no values for the year');
  return out;
}

// The proposal kept in the settings (ratio_proposal): values per person, or an error.
export function buildProposal({ budgetYear, members, table, error }) {
  const surveyYear = surveyYearFor(budgetYear);
  const { items, problems } = lookups(members, budgetYear);
  const base = { budget_year: budgetYear, survey_year: surveyYear, created_at: new Date().toISOString() };
  if (error) return { ...base, error: String(error).slice(0, 1000), problems };
  const values = items.map((it) => {
    const hit = table.find((r) => r.sex === it.sex && r.ageClass === it.ageClass);
    return { ...it, value: hit ? hit.value : null };
  });
  const missing = values.filter((v) => v.value === null);
  if (problems.length || missing.length || values.length < 2) {
    return { ...base, error: missing.length ? 'some values were not found' : 'people are not ready', problems, values };
  }
  return { ...base, values, problems: [] };
}

// Text of where a value comes from: '令和6年 男 30～34歳 294.6千円'.
export function sourceText(p, v) {
  return `${reiwa(p.survey_year)} ${SEX_LABEL[v.sex]} ${v.ageClass}${v.value ? ` ${v.value}千円` : ''}`;
}
