# dsh-opencode-zen-free-provider

OpenCode Zen Free provider for dsh.

[简体中文](README.md)

This plugin adds OpenCode Zen's free models to dsh. At startup it syncs the OpenCode Zen and models.dev catalogs, then exposes the models whose ids end in `-free`.

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

## License

[MIT](LICENSE)
