# dsh-plugin-opencode-usage

> OpenCode Go 订阅用量悬浮面板：在 DeepSeek Harness Web GUI 左侧侧边栏**设置按钮上方**显示订阅额度使用情况。

![DSH Plugin](https://img.shields.io/badge/dsh-plugin-1a73e8?style=flat-square)
![Platform](https://img.shields.io/badge/platform-web-0a7d33?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-333?style=flat-square)

## 功能

- 在侧边栏底部 Cordis 面板与设置按钮之间注册入口按钮
- 点击弹出悬浮面板，展示 OpenCode Go 订阅的三类额度：

| 窗口 | 官方接口字段 | 默认总额度 |
| --- | --- | --- |
| 滚动用量 | `usage.rolling` | $12（5 小时滚动） |
| 每周用量 | `usage.weekly` | $30 |
| 每月用量 | `usage.monthly` | $60 |

- 每张卡片显示：**剩余额度 / 已用额度 / 总额度 / 使用百分比 / 重置时间**
- 面板跟随侧边栏实际像素定位，侧边栏展开、收起、拖拽时自动调整
- 打开期间每 60s 自动刷新；支持 `Esc` 与点击面板外部关闭
- API key 只在 Harness host 进程内解析，不会下发浏览器

## 截图

```
┌───────────────────────────┐
│ OpenCode Go 订阅用量    ✕ │
│ opencode-go · 更新于 …     │
├───────────────────────────┤
│ 滚动用量        5 小时窗口 │
│ $8.40 剩余                 │
│ 已用 $3.60 / 总额 $12.00 · 30% │
│ ████████░░░░░░░░░░░░░░░   │
│ 额度重置: 08-15 17:05      │
├───────────────────────────┤
│ 每周用量        自然周窗口 │
│ $24.30 剩余                │
│ 已用 $5.70 / 总额 $30.00 · 19% │
│ ███████░░░░░░░░░░░░░░░░   │
│ 额度重置: 08-17 00:00      │
├───────────────────────────┤
│ 每月用量        自然月窗口 │
│ $54.60 剩余                │
│ 已用 $5.40 / 总额 $60.00 · 9% │
│ ███░░░░░░░░░░░░░░░░░░░░   │
│ 额度重置: 09-14 12:42      │
└───────────────────────────┘
```

## 工作原理

```text
DSH Web 浏览器
   │  1. 点击侧边栏按钮
   ▼
GET /plugins/opencode-usage/stats
   │
   ▼
DSH Host 插件
   │  2. ctx.credentials.resolve("OPENCODE_GO_API_KEY")
   │  3. GET https://opencode.ai/zen/go/v1/usage
   │     Authorization: Bearer <api-key>
   │  4. percent × limit → used / remaining
   ▼
返回 JSON，由 React 面板渲染
```

官方接口只返回 `percent` 与 `resetsAt`：

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 30, "resetsAt": "..." },
    "weekly":  { "status": "ok", "percent": 19, "resetsAt": "..." },
    "monthly": { "status": "ok", "percent": 9,  "resetsAt": "..." }
  }
}
```

插件按 OpenCode Go 官方套餐额度（<https://opencode.ai/docs/go/#usage-limits>）换算：

```text
used      = limit × percent / 100
remaining = limit - used
```

## 目录结构

```text
dsh-plugin-opencode-usage/
├── cordis.patch.yml   # bundle patch: 把插件插入 profile host 组合
├── lib/
│   ├── index.js       # Host 半: 订阅额度 API 查询 + HTTP 路由
│   └── client.js      # Client 半: 侧边栏按钮 + 悬浮面板
├── LICENSE
├── package.json       # dsh.bundle / dsh.client 元数据
└── README.md
```

## 安装

```sh
cd /path/to/your/workspace
dsh plugin --profile web add ./dsh-plugin-opencode-usage
```

也可以安装已发布的 GitHub 仓库（`prepare` 无构建步骤，可直接引用）：

```sh
dsh plugin --profile web add github:jiekesu967/dsh-plugin-opencode-usage
```

安装后 `dsh plugin` 会自动写入 web profile 的 `dependencies`，并把
`dsh-plugin-opencode-usage` 追加到 `dsh.profile.bundles`。重启 `dsh web`
并刷新页面后，设置按钮上方会出现 “OpenCode Go 用量” 入口。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖 `opencode-usage` 条目：

```yaml
- id: opencode-usage
  config:
    # Harness credentials 文件中保存 API key 的变量名
    credentialRef: OPENCODE_GO_API_KEY

    # OpenCode Go 订阅接口
    apiBaseUrl: https://opencode.ai/zen/go/v1

    # 货币符号
    currency: "$"

    # host 成功结果缓存时间
    cacheMs: 30000

    # 官方调整套餐额度时，改这里即可，无需改代码
    limits:
      rolling: 12
      weekly: 30
      monthly: 60
```

### 凭据

在 `~/.dsh/.credentials.yaml` 中确认存在：

```yaml
OPENCODE_GO_API_KEY: sk-...
```

也可以通过 DSH Web 的 Models / Credentials 设置页写入。

## 面板定位规则

面板不写死坐标，而是用 `ResizeObserver` 监听侧边栏列：

1. 优先放在侧边栏右缘外侧 `12px`，最大宽度 `392px`
2. 右侧剩余空间不足 `200px` 时，自动退回视口内
3. 侧边栏展开 / 收起 / 拖拽 / 窗口缩放时实时跟随

## 已知限制

- 官方 usage 接口只返回百分比，不返回绝对金额；绝对额度由 `limits` 配置计算
- 如果 OpenCode 调整 Go 套餐额度，需要同步更新 `limits` 配置
- 仅适用于 `web` profile；`headless` 下不注册路由

## License

MIT
