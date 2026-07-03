---
id: B11
title: 统一错误/健康呈现面 + 账户 banner(静默失败清零底座)
type: ux
priority: P1
status: in-sprint
repo: A
created: 2026-07-03
sprint: 2026-07-03-s11-cloud-loop
source: 册 §6.2(32 失败点审计)
---

## 背景/证据
审计:32 个失败点 22 个(~69%)对用户零反馈;最刺眼:账户读取失败误显「钱包按量扣费」、project.list 失败侧栏空白、登录整链失败静默。已修部分(PR #24):侧栏 `store.error`+重试、首条消息 create 失败 keep-text+toast。剩余:统一错误面、账户 banner 态、B23(配置清零)呈现。B20/C20/C21 的公共底座,应先做。

## 验收标准
1. `AlphaProjectsStore.error` / `ExtensionsStore.error` / 账户读取失败全部有渲染(banner/占位态,不误显默认值);
2. 统一 toast/错误呈现体系(一处定义,各处复用);
3. 32 失败点清单复扫:≥90% 有用户可见反馈,剩余逐条记录豁免理由;
4. B23(全局配置解析失败静默清零)有显式告警入口。

## 关联
B20/C20/C21(S8 同批)、B23、册 §6.2 失败点清单。
