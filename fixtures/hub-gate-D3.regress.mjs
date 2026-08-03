import { hubViolations } from '/Users/praise/AI-Agent/Claude/capabilities/source/pr-autopilot/scripts/fix-plan.mjs';
const SHARE = 0.5;
let pass = 0, fail = 0;
const t = (name, got, want) => { const ok = got === want; ok ? pass++ : fail++; console.log((ok?'  ✓':'  ✗ ')+name+(ok?'':`  期望 ${want} 得到 ${got}`)); };

// A. 本门原本要拦的攻击：8 条独立 finding 各挂一个共享 .gitignore
//    抽掉 .gitignore → 8 组（真把可并行串行化了）→ 必须仍报
const attack = Array.from({length:8},(_,i)=>({sc_id:'A'+i, paths:['.gitignore', `src/f${i}.ts`].sort()}));
t('攻击场景（共享 .gitignore 把 8 个独立 SC 合成 1 组）→ 仍报',
  hubViolations(attack, SHARE, 'fix').length, 1);

// B. 单模块多文件（本次死锁形态）：全部 SC 共享 core.ts + core.test.ts，抽任一仍 1 组
const lock = Array.from({length:13},(_,i)=>({sc_id:'B'+i, paths:['core.ts','core.test.ts'].sort()}));
t('单模块多文件（抽任一路径仍 1 组）→ 放行',
  hubViolations(lock, SHARE, 'fix').length, 0);

// C. D1 的真耦合（唯一锚点就是该共享路径）→ 放行（回归，不得被本次改动破坏）
const solo = Array.from({length:3},(_,i)=>({sc_id:'C'+i, paths:['only.ts']}));
t('D1 真耦合（余集为空）→ 放行',
  hubViolations(solo, SHARE, 'fix').length, 0);

// D. 混合：共享 hub + 各自独立文件，但另有一条把两个 SC 绑在一起
//    抽掉 hub 后 7 组（原 1 组）→ 仍报
const mixed = [
  ...Array.from({length:6},(_,i)=>({sc_id:'D'+i, paths:['hub.ts', `u${i}.ts`].sort()})),
  {sc_id:'D6', paths:['hub.ts','u6.ts'].sort()}, {sc_id:'D7', paths:['hub.ts','u6.ts','u7.ts'].sort()},
];
t('混合（抽 hub 后 1→7 组）→ 仍报', hubViolations(mixed, SHARE, 'fix').length, 1);

// E. 未达占比阈值 → 本来就不该报
const low = [{sc_id:'E0',paths:['h.ts','a.ts']},{sc_id:'E1',paths:['h.ts','b.ts']},{sc_id:'E2',paths:['h.ts','c.ts']},
             {sc_id:'E3',paths:['x.ts']},{sc_id:'E4',paths:['y.ts']},{sc_id:'E5',paths:['z.ts']},{sc_id:'E6',paths:['w.ts']}];
t('占比未越线（3/7 < 0.5）→ 不报', hubViolations(low, SHARE, 'fix').length, 0);

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
