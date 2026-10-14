# Desktop 播放与歌词同步

跨仓类型定义位于 UI `packages/app/src/host/contract.ts` 和 Desktop
`src/shared/hook-contract.ts`，两份文件保持完全一致。

## 能力协商与兼容

Desktop 注入旧 `$MeTMusic_Hook`，并在 `$MeTMusic_registerHost` 注册可选的
`onPlaybackSync` 回调。支持该回调的 UI 使用新协议；旧 UI 继续发送原 Hook。
新 UI 在没有该回调的旧 Desktop 上仍逐 tick 调用原 Hook，原有 v1/v2 payload
和 `contractVersion: 2` 保持不变。公开 `$MeTMusic_Data` 在新模式下按读取时计算。

## 两种消息

- `kind: song`：注册宿主，以及歌曲、封面、封面主题、歌词或歌词时间设置变化时，
  发送一次完整数据。包括歌曲 id、名称、歌手、专辑、时长、封面 URL、主题、
  全部歌词行与逐字时间轴，以及当前播放进度。
- `kind: progress`：仅包含 `revision`、`currentTime`、`duration`、`timestamp`、
  `isPlaying`、`playbackRate`。正常播放每 **500ms** 校准一次；播放/暂停、
  缓冲状态、倍速、seek 或进度明显偏离预期时立即发送。暂停进度变化立即发送，
  暂停静止时不定期发送。

`currentTime`、`duration` 单位为秒；`timestamp` 为 `Date.now()` 的 Unix 毫秒。
歌词行、字时间和 `lineOffset`、`wordOffset` 单位为毫秒。`revision` 在完整快照
更新时递增，进度包只能应用到对应快照，防止曲目/歌词时间轴混用。
普通歌词保留行偏移与逐字偏移的独立语义；TTML 过滤背景人声，显示最近触发的
主唱或对唱行，行选择与逐字进度使用同一时间平移。

## Desktop 歌词时钟

主进程缓存整曲和最新进度，通过专用 IPC 转发；歌词窗初始化或再次显示时补齐状态。
歌词组件用系统时间差补偿 IPC 延迟，再以 `performance.now()` 的单调时钟按倍速
推进进度，每秒 30 次本地更新歌词/逐字染色，不产生额外 IPC。暂停立即冻结，seek
立即重定位，总时长已知时将位置限制在曲目范围内。重复文本通过行 id 识别换行。

## 验证

UI：`pnpm --filter @met/app e2e host-playback-sync host-ttml-lyrics`

Desktop：`pnpm typecheck`、`node --test tests/*.test.ts`、`pnpm build`
