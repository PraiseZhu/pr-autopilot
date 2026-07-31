# SC 提炼例句库（E3 自进化迭代对象）

> R7 白名单文件：周会可通过提案 PR 追加好/坏例句，不得删除历史例句（append 风格）。

SC 三段式：**改什么 / 什么该成立 / 怎么验证**。写不出第三段的 SC 不合格。

## 好例句

- 「修复 `useCanvasDrag` 在指针抬起前卸载组件时的监听器泄漏 / 卸载后 window 上无残留 pointermove 监听 / 新增回归测试断言 removeEventListener 被调用」
- 「补 registry.mivo.json 缺失的 src/render 路径 / 改 src/render 下文件的 diff 判 touches_ui=true / fixtures 里对应用例由 fail 转 pass」

## 坏例句（禁止的模式）

- 「优化代码质量」——没有改什么，没有验证方法（不可验证）
- 「确保测试通过」——验证方法是同义反复（歧义）
- 「修复 reviewer 提到的问题」——没有指明哪条 finding（漏项风险）
