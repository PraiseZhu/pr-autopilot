# finding 归属表（§1.1b ⑪）

> R7 白名单文件：周会可提案补充映射行（E1 face-gap 类漏检的迭代对象）。

每条 finding 恰好一个 `primary_face` + 可选 `related_faces`（不重复计数）。

| 情形 | primary_face |
|---|---|
| 测试声称缺证据 | G |
| 授权路径运行失败 | E |
| 描述与实现不符——实现错 | A |
| 描述与实现不符——描述错 | D |
| 描述与实现不符——声称假 | G |
| 兼容/迁移/构建集成/资源泄漏 | A（兜底） |

命中 blocker 白名单但映射不进任何面 → 记 `taxonomy_gap` 并 degraded 停轮，禁止丢弃。
