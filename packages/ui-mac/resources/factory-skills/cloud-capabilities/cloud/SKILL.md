---
name: cloud
description: /cloud 入口：按 cloud-capabilities 判断本机还是云端，并执行登录、费用和上传授权检查。
license: MIT (Code Puppy original)
---

# /cloud

这是 Code Puppy 的本机与云端判断入口，规则正文在 `cloud-capabilities`。

1. 加载并遵循 `cloud-capabilities` 技能，再处理用户的请求。
2. 按其判断表选择执行位置，并保留用户明确提出的执行位置要求。
3. 按其流程检查登录、费用与私有文件上传授权，再执行任务。
4. 依照任务的真实状态报告结果。产物由宿主下载到本机并核对，不要自行声称已保存或给出保存路径。
