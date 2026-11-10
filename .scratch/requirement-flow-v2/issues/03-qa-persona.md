# 03: 自测助手发布后自测

**What to build:** 自测助手新增“发布后自测”流程：收研发派单、从 params/version/PR diff 推导影响范围、在允许范围内执行、写 `self-test/` 报告、把结论回给派单会话。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 能识别【自测】派单，读取版本目录/params/PR/环境/包/允许操作
- [ ] 自测范围由自己推导，不依赖派单方给定
- [ ] 允许范围内可调测试环境接口、造带唯一前缀的幂等测试数据，并逐条记录
- [ ] 禁止 DDL、改配置、重启其它服务；超范围先回报研发
- [ ] 报告写 `docs/qs-end-end/<版本目录>/self-test/w<N>-<时间>.md`
- [ ] 结论回给派单会话（消息头 session），不直接找 PM
- [ ] 通过口径 = 影响范围内无新增失败；存量单列
- [ ] `peers` 增加 `dev-assistant`；保持 single
