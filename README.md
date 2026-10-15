# dsh-opencode-zen-free-provider

OpenCode Zen Free provider for dsh.

[English](README.en.md)

<img height="650" alt="image" src="https://github.com/user-attachments/assets/8cc57d90-76b8-4a7d-a9fe-1ebb39c4f51c" />

本插件可以将 OpenCode Zen 的免费模型接入 dsh 使用。插件启动时从 OpenCode Zen 和 models.dev 同步模型目录与所有元数据，**仅抓取一次**，不轮循。哪怕启动时拉取失败，插件也能正常挂载，路由以空目录提供服务。

上下文窗口默认以 models.dev 的元数据为准。**MiMo V2.6 Flash 与 DeepSeek V4.1 Flash 例外**：它们的后端实际服务 1M，但 models.dev 给免费档只登记了 200K 那一档，本插件按 1M 声明。实测 `deepseek-v4.1-flash-free` 在 104 万 prompt tokens 时仍返回 200，把针藏在 3MB 文档 93% 深处也能准确取回；真正的天花板是请求体大小（约 3.9MB 字符）而不是上下文窗口。

## 安装

从 npm 安装（预构建产物，推荐）：

```sh
dsh plugin --profile web add @jiesou/dsh-opencode-zen-free-provider
```

或从 GitHub 安装：

```sh
dsh plugin --profile web add github:jiesou/dsh-opencode-zen-free-provider
```

## 安装之后

模型列表**无需任何配置**，插件启动时会自动从远程同步并过滤所有免费模型。在 Web Models 页面选择 OpenCode Zen Free 和模型后即可开始使用。

## 推理深度（Reasoning effort）

模型只暴露上游接受的档位，不造档位。**Default** 表示"不发送 `reasoning_effort`"字段，由上游自行决定深度。**Off** 是真开关——发送上游的关闭字面值（`none`、`off` 等）。effort 配置为空或只有 toggle 的模型干脆不显示档位选择器。

## 错误提示

OpenCode Zen 把非凭证类拒绝（免费额度到期、区域限制等）以 HTTP 401/403 返回，dssharness 会把这些状态码归类为"API Key 无效"。本插件在终端错误事件里保留真实原因，让真因显示出来；真正的鉴权失败仍按 AUTH 走。无法解析的内容原样透传。

若看到 `FreeTierError: OpenCode's free tier can only be used from within OpenCode`，那是**上游的客户端指纹门**，与本插件无关，也不是 API Key 问题。2026-10-11 起免费层从 `/zen/v1` 迁到 `/inference/v1`，门禁下沉到不可审计的私有 inference 服务。本插件按实测通过条件构造请求：

- 走 `/inference/v1`（`/zen/v1` 对匿名请求一律 403）；
- 四个 session 头同值双发：`x-opencode-session`、`x-opencode-session-id`、`x-session-affinity`、`x-session-id`；
- `x-opencode-project: global`（40-hex project id 会触发 403）；
- **不发** `x-opencode-request`，**不发** `HTTP-Referer`——这两个头的存在本身就会触发 403；
- session id 前 12 位 hex 必须是反转时间戳（`ses_` 降序、`msg_` 升序），纯随机即拒；
- 请求的 tools 必须包含 `bash` 与 `read`（按小写名精确匹配），缺任一即 403。精简、标题、摘要等工具数不足的请求由本插件自动补齐占位工具。

提示：OpenCode 的 Free 模型会被基于 IP 限流。

对于 Ox Alpha 等经常遇到"network errors"等问题的模型，建议手动设置：

```yaml
- id: opencode-zen-free-provider
  name: '@jiesou/dsh-opencode-zen-free-provider'
  config:
    retryPolicy:
      mode: always
    maxRequestImageBytes: 2097152
    requestImageMaxBytes: 1048576
```

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `retryPolicy` | `object` | 省略即用普通默认 | 模型请求重试策略 |
| `maxRequestImageBytes` | `number` | `2097152`（2 MiB） | 单次请求允许内联的 base64 图片字节上限 |
| `requestImageMaxBytes` | `number` | `1048576`（1 MiB） | 单张图片重编码后的字节上限 |

## 图片预算

Zen 这条 wire 是无状态的：每轮请求都要把历史重新发一遍，留在上下文里的图片因此每轮都会再传一次。

- 每张图片先归一化（2048×2048 像素总预算），再重编码到 `requestImageMaxBytes`（默认 1 MiB）以内。
- 一轮请求内联的 base64 图片总量超过 `maxRequestImageBytes`（默认 2 MiB）时，不发请求，而是抛出 `IMAGE_OFFLOAD_REQUIRED` 并报出需要 offload 的张数。DSH 据此把**最旧**的图片记入 `image/offload` 事件并重试；之后每轮用占位文本代替这些图片的字节，模型仍能从占位文本里读到图片身份和可读路径。
- 已经 offload 的图片不再读取字节、不再编码、不再上传。

两个值都是 base64 口径（约等于原图字节 ×4/3）。默认组合约等于"一张整尺寸图 + 一张半尺寸图"。想让模型一次看更多图就调大，想省流量就调小；但 `maxRequestImageBytes` 必须大于单张的 base64 长度（1 MiB 图约 1.4 MB），否则一张图也放不下。

## License

[MIT](LICENSE)
