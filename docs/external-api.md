# 桌面端外部接口契约

固定结构定义在 `src/shared/external-api-contract.ts`，机器定义见
[external-api.schema.json](external-api.schema.json)。所有时间单位为毫秒。

| 接口 | 固定数据 |
| --- | --- |
| `POST /api/seek` | `{ "positionMs": 非负有限数值 }` |
| `POST /api/volume` | `{ "volume": 0到1的有限数值 }` |
| `GET /api/status` | `PlaybackSnapshot` |
| `GET /api/now-playing` | `NowPlaying` |
| `GET /api/lyrics` | `LyricsSnapshot` |
| WebSocket `/ws` 命令 | `op=play/pause/stop/next/prev` 无额外数据；seek 带 positionMs；setVolume 带 volume |
| WebSocket state 事件 | state（playing/paused/stopped）、position、duration |
| WebSocket progress 事件 | position、duration、lyricText |
| WebSocket track 事件 | id、name、artist、可选 cover、duration |

请求体和 WebSocket 命令禁止未知字段，缺失或错误字段按现有 HTTP 400 / WS error 分支处理。
命令没有鉴权；仍使用现有默认 loopback 监听配置。
广播数据按事件名绑定类型并校验。播放快照返回前按对应 schema 校验。
`hello/ack/error/event` 是明确的服务端消息联合类型，既有字段名保持不变。

导出与验证（Node.js 22.18+ 的 TypeScript 类型剥离支持，开发环境当前为 Node 24）：

```bash
node --experimental-strip-types scripts/export-external-api-schema.mjs
node --experimental-strip-types --test tests/external-api-contract.test.ts
pnpm typecheck
pnpm build
```

宿主 HookPayload v2 未改变其运行时数据或版本。初始化占位数据的 TypeScript 类型从
任意字典改为实际已有的固定字段，UI 与桌面端的契约副本同步修改。
