# dsh-opencode-zen-free-provider

OpenCode Zen Free provider for dsh.

[简体中文](README.md)

<img height="650" alt="image" src="https://github.com/user-attachments/assets/8cc57d90-76b8-4a7d-a9fe-1ebb39c4f51c" />

This plugin adds OpenCode Zen's free models to dsh. At startup it syncs the OpenCode Zen and models.dev catalogs and exposes the models whose ids end in `-free`; the catalog is fetched once, no rescan. If the first scan fails the plugin still mounts with an empty catalog — one network blip never takes the model surface down.

## Install

From npm (prebuilt, recommended):

```sh
dsh plugin --profile web add @jiesou/dsh-opencode-zen-free-provider
```

Or from GitHub:

```sh
dsh plugin --profile web add github:jiesou/dsh-opencode-zen-free-provider
```

## After install

The free endpoint works without an API key and uses the anonymous `Bearer public` credential by default. If `OPENCODE_ZEN_FREE_API_KEY` is stored through DSH's credentials service, it takes precedence.

No model configuration is needed. Pick the OpenCode Zen Free provider and a model on the Web Models page to start using it.

## Reasoning effort

A model exposes exactly the levels the upstream feed credits it with. **Default** means "do not send `reasoning_effort`" — the upstream picks its own depth. **Off** is a real switch: it sends the upstream's literal close value (`none`, `off`, …). Models whose effort entry is empty or a `toggle` show no level selector at all.

## Error reporting

OpenCode Zen returns non-credential refusals (ended free promotions, region blocks, …) as HTTP 401/403, which dsh otherwise classifies as "invalid API key". The plugin preserves the real reason in the terminal error event; genuine auth failures still surface as AUTH. Anything unparseable passes through verbatim — the original error is never swallowed.

## Image budget

The Zen wire is stateless: every request re-sends the history, so every image left in context is uploaded again on every turn.

- Each image is normalized first (2048×2048 pixel budget), then re-encoded to fit `requestImageMaxBytes` (1 MiB by default).
- When the inline base64 images of one request exceed `maxRequestImageBytes` (2 MiB by default), no request is sent; the adapter throws `IMAGE_OFFLOAD_REQUIRED` naming how many occurrences must be offloaded. DSH records the **oldest** ones in an `image/offload` event and retries; from then on their bytes are replaced by placeholder text that still names the image identity and a readable path.
- Already-offloaded images are never read, re-encoded, or uploaded again.

```yaml
- id: opencode-zen-free-provider
  name: '@jiesou/dsh-opencode-zen-free-provider'
  config:
    retryPolicy:
      mode: always
    maxRequestImageBytes: 2097152
    requestImageMaxBytes: 1048576
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `retryPolicy` | `object` | normal defaults when omitted | Per-request retry policy |
| `maxRequestImageBytes` | `number` | `2097152` (2 MiB) | Inline base64 image budget for one request |
| `requestImageMaxBytes` | `number` | `1048576` (1 MiB) | Per-image budget after re-encoding |

Both values count base64 characters (about 4/3 of the raw bytes). The default pair holds one full-size image plus one half-size image; raise them to show the model more images at once, lower them to save bandwidth — but keep `maxRequestImageBytes` above one image's base64 length (a 1 MiB image is ~1.4 MB), or not even one image fits.

## License

[MIT](LICENSE)
