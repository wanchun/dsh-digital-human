# 07 · 派单必带需求

Type: task
Status: resolved

## Question

digital_human_send 增加必填参数 requirement（线程名或目录名）。缺失即拒绝，错误信息说明"派单必须带需求"。
被派方据此定位需求目录；工具把解析出的绝对路径写进消息头部，放在 <dsh_peer_source> 之后、正文之前。

现有调用（测试、脚本）若不带该参数，要按新契约更新；确认没有静默降级。

## Resolution

已实现并验证：requirement 必填，缺失抛错，需求目录写进消息头
