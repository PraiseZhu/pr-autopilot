// 加固清单类别注册表——单一来源（D5/加固清单第 7 类「文档/校验/schema/fixture 不得四处手抄数字」）。
// references/hardening-checklist.md 的类别数改动时，只改这里的 HARDENING_CLASSES；
// verdict-validate.mjs / fixtures 从本文件派生 count，不再各自硬编码 9 或 10。
// 唯一无法从本文件派生的是 schemas/review-verdict.schema.json 的 class_id maximum
// （JSON Schema 是静态数据，不能 import JS 常量）——该处改动必须与本文件手动同步，
// schema 里留了指向本文件的注释，防止两处再次漂移互不知情。
//
// checklist_version：清单类别集合发生 exact 变更（不是新增一条 append，是 9→10 这种
// 影响既有 R1 verdict 是否仍完整覆盖的变更）时递增。verdict-validate.mjs 强制 R1 两
// 对抗席的 verdict.checklist_version 必须等于当前值——版本不符时报「清单版本过期需
// 重审」，不与「缺 N 项」的普通计数错误混为一谈（D5）。
export const HARDENING_CHECKLIST_VERSION = 2;

// class_id 1..10，对应 hardening-checklist.md 的十行。
export const HARDENING_CLASSES = Array.from({ length: 10 }, (_, i) => i + 1);
export const HARDENING_CLASS_COUNT = HARDENING_CLASSES.length;
