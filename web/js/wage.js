// The ratio of the two people from wage statistics (2026-11-03).
//
// 厚生労働省「賃金構造基本統計調査」: 一般労働者の性、年齢階級別の賃金（所定内給与額、千円）. For the budget of
// year Y the results of Y-2 are used (the household's rule: the previous year's results are not out
// in time). Each person's value is the one of their sex and of the age group they are in during Y.
// The numbers are entered by hand (the API tables of e-Stat do not hold the whole-country values of
// recent years); every 1 December the administrators are reminded with what to look up.

export const SURVEY_LAG = 2;
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

// What to look up, as text: '令和6年 男 30～34歳'.
export function lookupText(surveyYear, it) {
  return `${reiwa(surveyYear)} ${SEX_LABEL[it.sex]} ${it.ageClass}`;
}
