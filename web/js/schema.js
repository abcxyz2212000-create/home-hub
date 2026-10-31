// Ledger definitions. Forms, lists, detail pages and CSV columns are generated from these.
//
// Field types:
//   text, textarea, email, url, select(options), int, last4, code(digits), accountno, holder, date, month(YYYY-MM),
//   day(1-31), monthnum(1-12), bool, ref(ledger), payment(card or account),
//   links, tags, status

export const LEDGER_ORDER = ['accounts', 'cards', 'contracts', 'items', 'memberships'];

const STATUS_OPTIONS = [
  ['active', '利用中'],
  ['closed', '解約済み'],
];

function common(nameLabel) {
  return {
    head: [{ key: 'name', label: nameLabel, type: 'text', required: true, max: 200 }],
    tail: [
      { key: 'holder', label: '名義人', type: 'holder', max: 100 },
      { key: 'status', label: '状態', type: 'status', options: STATUS_OPTIONS },
      { key: 'links', label: '関連リンク', type: 'links' },
      { key: 'password_location', label: 'パスワードの保管先', type: 'text', max: 200, placeholder: '例: Google パスワードマネージャーの「○○銀行」' },
      { key: 'memo', label: 'メモ', type: 'textarea', max: 5000 },
      { key: 'tags', label: 'タグ', type: 'tags', placeholder: '空白または「、」区切り' },
    ],
  };
}

function ledger(def) {
  const c = common(def.nameLabel);
  return { ...def, fields: [...c.head, ...def.fields, ...c.tail] };
}

export const LEDGERS = {
  accounts: ledger({
    key: 'accounts',
    label: '口座',
    nameLabel: '名称',
    csvName: '口座',
    fields: [
      { key: 'institution', label: '金融機関名', type: 'text', max: 100 },
      { key: 'bank_code', label: '金融機関コード', type: 'code', digits: 4 },
      { key: 'branch', label: '支店', type: 'text', max: 100 },
      { key: 'branch_code', label: '支店番号', type: 'code', digits: 3 },
      { key: 'kind', label: '種別', type: 'select', options: ['普通', '定期', '当座', '貯蓄', '証券', 'NISA', 'iDeCo', 'その他'] },
      { key: 'account_no', label: '口座番号（全桁）', type: 'accountno' },
      { key: 'purpose', label: '用途', type: 'text', max: 200 },
      { key: 'mf_linked', label: 'マネーフォワード連携', type: 'bool' },
    ],
    summary: (r) => [r.institution, r.branch, r.kind, r.last4 && `下4桁 ${r.last4}`],
    // Headers of the existing "口座マスタ" spreadsheet, accepted by the CSV import as-is.
    csvAliases: { 摘要: '名称', 支店名: '支店', 預金科目: '種別', 口座番号: '口座番号（全桁）', 口座名義: '名義人' },
  }),
  cards: ledger({
    key: 'cards',
    label: 'クレジットカード',
    nameLabel: 'カード名',
    csvName: 'クレジットカード',
    events: ['card_expiry', 'annual_fee'],
    fields: [
      { key: 'brand', label: 'ブランド', type: 'select', options: ['VISA', 'Mastercard', 'JCB', 'American Express', 'Diners Club', 'その他'] },
      { key: 'last4', label: '下4桁', type: 'last4' },
      { key: 'expiry_ym', label: '有効期限（年月）', type: 'month' },
      { key: 'debit_account_id', label: '引き落とし口座', type: 'ref', ref: 'accounts' },
      { key: 'closing_day', label: '締め日', type: 'day' },
      { key: 'payment_day', label: '支払日', type: 'day' },
      { key: 'annual_fee', label: '年会費（円）', type: 'int', max: 10000000 },
      { key: 'annual_fee_month', label: '年会費の発生月', type: 'monthnum' },
      { key: 'family_card', label: '家族カードあり', type: 'bool' },
      { key: 'etc_card', label: 'ETCカードあり', type: 'bool' },
    ],
    summary: (r) => [r.brand, r.last4 && `下4桁 ${r.last4}`, r.expiry_ym && `有効期限 ${r.expiry_ym}`],
  }),
  contracts: ledger({
    key: 'contracts',
    label: '契約・固定費',
    nameLabel: '契約名',
    csvName: '契約・固定費',
    events: ['contract_renewal'],
    fields: [
      { key: 'category', label: '種類', type: 'select', options: ['光熱', '通信', '保険', 'サブスク', '住居', '車', '教育', 'その他'] },
      { key: 'amount', label: '金額（円）', type: 'int', max: 100000000 },
      { key: 'cycle', label: '周期', type: 'select', options: [['monthly', '月払い'], ['yearly', '年払い']] },
      { key: 'payment', label: '支払方法', type: 'payment' },
      { key: 'contract_date', label: '契約日', type: 'date' },
      { key: 'renewal_date', label: '更新日', type: 'date' },
      { key: 'auto_renew', label: '自動更新', type: 'bool' },
      { key: 'cancel_method', label: '解約方法・連絡先', type: 'textarea', max: 2000 },
      { key: 'contract_no', label: '契約番号', type: 'text', max: 100 },
      { key: 'doc_location', label: '書類の保管場所', type: 'text', max: 200 },
    ],
    summary: (r) => [r.category, r.amount != null && `${r.amount.toLocaleString('ja-JP')}円/${r.cycle === 'yearly' ? '年' : '月'}`, r.renewal_date && `更新日 ${r.renewal_date}`],
  }),
  items: ledger({
    key: 'items',
    label: '書類・家電',
    nameLabel: '品名',
    csvName: '書類・家電',
    events: ['warranty'],
    photos: true,
    fields: [
      { key: 'maker', label: 'メーカー', type: 'text', max: 100 },
      { key: 'model', label: '型番', type: 'text', max: 100 },
      { key: 'purchase_date', label: '購入日', type: 'date' },
      { key: 'shop', label: '購入店', type: 'text', max: 100 },
      { key: 'warranty_until', label: '保証期限', type: 'date' },
      { key: 'manual_url', label: '説明書URL', type: 'url' },
      { key: 'location', label: '保管場所', type: 'text', max: 200 },
    ],
    summary: (r) => [r.maker, r.model, r.warranty_until && `保証期限 ${r.warranty_until}`],
  }),
  memberships: ledger({
    key: 'memberships',
    label: 'ポイントカード・会員情報',
    nameLabel: 'サービス名',
    csvName: 'ポイントカード・会員情報',
    fields: [
      { key: 'issuer', label: '発行元', type: 'text', max: 100 },
      { key: 'kind', label: '種類', type: 'select', options: ['ポイントカード', '会員登録', 'アプリ会員', 'その他'] },
      { key: 'member_last4', label: '会員番号下4桁', type: 'last4' },
      { key: 'email', label: '登録メールアドレス', type: 'email' },
      { key: 'card_id', label: '紐づくカード', type: 'ref', ref: 'cards' },
      { key: 'points_expiry', label: 'ポイント有効期限（記録のみ・通知なし）', type: 'date' },
    ],
    summary: (r) => [r.kind, r.issuer, r.member_last4 && `下4桁 ${r.member_last4}`],
  }),
};

export function optionPairs(field) {
  return (field.options || []).map((o) => (Array.isArray(o) ? o : [o, o]));
}

export function optionLabel(field, value) {
  const hit = optionPairs(field).find(([v]) => v === value);
  return hit ? hit[1] : value;
}
