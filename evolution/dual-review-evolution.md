# 双审漏检台账（SP-6）

运行态空账。机器事实源是同目录 `ledger.jsonl`（append-only，`ledger-append.mjs`）。

- 本文件给人看；jsonl 给 cluster / 周会。
- 空 = 机制在、还没有漏检条目。不要把空文件删掉，否则又变回「机制没建」。
- 团队可见副本若要进产品仓，走插件仓 `agent-use/docs/` 单向移植，不写跟随仓。
