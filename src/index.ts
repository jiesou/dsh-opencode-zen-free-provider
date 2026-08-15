import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createProvider, type Model, type ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

export const name = 'opencode-zen-free-provider'
export const inject = ['llm']

const PROVIDER = name
const BASE_URL = 'https://opencode.ai/zen/v1'
const USER_AGENT = 'opencode/1.18.16'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => {
    const original = globalThis.fetch
    const wrapped: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? new URL(input)
        : input instanceof Request ? new URL(input.url)
        : input instanceof URL ? input : undefined
      if (url === undefined || (url.hostname !== 'opencode.ai' && !url.hostname.endsWith('.opencode.ai'))) {
        return original(input, init)
      }
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
      headers.set('User-Agent', USER_AGENT)
      return original(input, { ...init, headers })
    }
    ;(globalThis as { fetch: typeof fetch }).fetch = wrapped
    return () => {
      if ((globalThis as { fetch: typeof fetch }).fetch === wrapped) {
        ;(globalThis as { fetch: typeof fetch }).fetch = original
      }
    }
  })

  const fetchJson = async (url: string, headers: Record<string, string>) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(url, { headers, signal: controller.signal })
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      const payload: unknown = await response.json()
      if (!isRecord(payload)) throw new Error(`${url}: unexpected response shape`)
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  const [zen, modelsDev] = await Promise.all([
    fetchJson(`${BASE_URL}/models`, { 'User-Agent': USER_AGENT, accept: 'application/json' }),
    fetchJson('https://models.dev/api.json', { accept: 'application/json' }),
  ])
  if (!Array.isArray(zen.data)) throw new Error('zen models: unexpected response shape')
  const openCode = modelsDev.opencode
  if (!isRecord(openCode) || !isRecord(openCode.models)) throw new Error('models.dev: no "opencode" provider')
  const modelsById = openCode.models

  const models = (zen.data as unknown[])
    .filter((entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry.id === 'string' && entry.id.endsWith('-free'))
    .flatMap((entry): Model<'openai-completions'>[] => {
      const id = entry.id as string
      const metadata = modelsById[id]
      if (!isRecord(metadata)) return []
      const option = (Array.isArray(metadata.reasoning_options) ? metadata.reasoning_options : [])
        .find(value => isRecord(value) && value.type === 'effort')
      const efforts = isRecord(option) && Array.isArray(option.values)
        ? option.values.filter((value): value is string => typeof value === 'string') : []
      const thinkingLevelMap: ThinkingLevelMap = { off: 'none' }
      for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
        thinkingLevelMap[level] = efforts.length === 0 || efforts.includes(level) ? level : null
      }
      const limit = isRecord(metadata.limit) ? metadata.limit : undefined
      const input = isRecord(metadata.modalities) && Array.isArray(metadata.modalities.input)
        ? metadata.modalities.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
        : []
      return [{
        id,
        name: typeof metadata.name === 'string' ? metadata.name : id,
        api: 'openai-completions', provider: PROVIDER, baseUrl: BASE_URL,
        headers: { 'User-Agent': USER_AGENT, 'HTTP-Referer': 'https://opencode.ai' },
        reasoning: true, thinkingLevelMap, input: input.length > 0 ? input : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: id === 'deepseek-v4-flash-free' ? 1_048_576
          : typeof limit?.context === 'number' ? limit.context : 1_048_576,
        maxTokens: typeof limit?.output === 'number' ? limit.output : 32_768,
      }]
    })
  if (models.length === 0) throw new Error('no OpenCode Zen free models resolved')
  ctx.logger.info('[%s] synced %d free model(s): %s', PROVIDER, models.length, models.map(model => model.id).join(', '))

  const adapter = new PiAiAdapter({
    profiles: () => new Map<string, ResolvedPiAiProviderProfile>([[PROVIDER, {
      provider: PROVIDER,
      displayName: 'OpenCode Zen Free',
      apiKeyEnv: credentialRef('OPENCODE_ZEN_FREE_API_KEY'),
      streamIdleTimeoutMs: 300_000,
      retryPolicy: resolveRetryPolicy(undefined, `${PROVIDER}: retryPolicy`),
      piProvider: createProvider({
        id: PROVIDER, name: 'OpenCodeZenFree', baseUrl: BASE_URL,
        auth: { apiKey: { name: 'OpenCodeZenFree', resolve: ({ credential }) => Promise.resolve({
          auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: 'OpenCodeZenFree',
        }) } },
        models, api: openAICompletionsApi(),
      }),
      configuredMaxTokens: new Map(),
    }]]),
    resolveApiKey: async (_provider, profile) => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const hit = await credentials.resolve(profile.apiKeyEnv!)
        if (hit !== undefined) return assertUsableApiKey(hit.value, PROVIDER, String(profile.apiKeyEnv))
      }
      return 'public'
    },
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
