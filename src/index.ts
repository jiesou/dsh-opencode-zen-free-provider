import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, errorChain, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { createProvider, type AuthContext, type Context as PiContext, type CredentialStore, type Model, type SimpleStreamOptions, type ThinkingLevelMap, type ProviderStreams } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
// Cloned (and minimized) from @earendil-works/pi-ai's openai-completions module.
// See src/openai-completions.ts for the source URL + the only change (zenFetch).
// The cloned copy re-declares AssistantMessageEventStream as a separate class
// identity, so its stream functions are cast back to the package's types here.
// Runtime behavior is identical; only the (private) class identity differs.
import { stream as _piAgentStream, streamSimple as _piAgentStreamSimple, installZenUserAgent } from './openai-completions.js'
const piAgentStream = _piAgentStream as unknown as ProviderStreams['stream']
const piAgentStreamSimple = _piAgentStreamSimple as unknown as ProviderStreams['streamSimple']

export const name = 'opencode-zen-free-provider'
export const inject = ['llm', 'settings']

const PROVIDER = name
const DISPLAY_NAME = 'OpenCode Zen Free'
const NS = settingsNamespace('opencode-zen-free-provider')
const OPENCODE_VERSION_URL = 'https://data.jsdelivr.com/v1/packages/npm/opencode-ai/resolved'
const OPENCODE_VERSION_FALLBACK = '1.18.18'

/** Envelope types that must stay AUTH-classified instead of being rewritten. */
const AUTH_ERROR_TYPES = new Set(['AuthError', 'authentication_error', 'invalid_api_key', 'unauthorized'])

export interface Config {
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  retryPolicy: RetryPolicySchema,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const resolveOpenCodeVersion = async (): Promise<string> => {
  try {
    const payload = await fetchJson(OPENCODE_VERSION_URL, { accept: 'application/json' })
    return typeof payload.version === 'string' && payload.version.length > 0 ? payload.version : OPENCODE_VERSION_FALLBACK
  } catch {
    return OPENCODE_VERSION_FALLBACK
  }
}

const opencodeId = (prefix: 'ses' | 'msg', value: string): string => {
  const digest = createHash('sha256').update(`dsh-opencode-${prefix}\0${value}`).digest()
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let number = BigInt(`0x${digest.toString('hex')}`)
  let encoded = ''
  while (number > 0) {
    encoded = alphabet[Number(number % 62n)] + encoded
    number /= 62n
  }
  while (encoded.length < 14) encoded = `0${encoded}`
  return `${prefix}_${digest.toString('hex').slice(0, 12)}${encoded.slice(0, 14)}`
}

const lastUserContent = (context: PiContext): string => {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index]
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') return message.content
    return message.content.map(part => part.type === 'text' ? part.text : part.data).join('\0')
  }
  return ''
}

const zenApiHeaders = (model: Model<'openai-completions'>, context: PiContext, options: SimpleStreamOptions) => {
  const sessionId = options.sessionId ?? 'dsh-session-unknown'
  const requestSeed = `${sessionId}\0${lastUserContent(context)}`
  return {
    ...model.headers,
    'HTTP-Referer': 'https://opencode.ai',
    'x-opencode-project': 'global',
    'x-opencode-session': opencodeId('ses', sessionId),
    'x-opencode-request': opencodeId('msg', requestSeed),
    'x-opencode-client': 'cli',
  }
}

// Replayed thinking blocks carry no wire signature; marking them
// `reasoning_content` keeps the transport from mangling history. Never gated on
// `model.reasoning`: a model with no effort control still streams thinking.
const normalizeReasoningContext = (context: PiContext): PiContext => ({
  ...context,
  messages: context.messages.map(message => message.role !== 'assistant' ? message : {
    ...message,
    content: message.content.map(block =>
      block.type === 'thinking' && block.thinking.trim().length > 0 && block.thinkingSignature === undefined
        ? { ...block, thinkingSignature: 'reasoning_content' }
        : block),
  }),
})

// Zen reports non-credential refusals (ended free promotions, region blocks) as
// HTTP 401/403, which the harness classifies as AUTH and masks as "API key is
// invalid". Rewriting the envelope (e.g. `401: {"type":"ModelError",…}`) to
// `[opencode-zen <type>] <message>` gets the real reason past that
// classification; genuine auth envelopes and unparseable text pass through.
const rewriteRefusalMessage = (errorMessage: string): string => {
  const start = errorMessage.indexOf('{')
  const end = errorMessage.lastIndexOf('}')
  if (start < 0 || end <= start) return errorMessage
  let parsed: unknown
  try { parsed = JSON.parse(errorMessage.slice(start, end + 1)) } catch { return errorMessage }
  if (!isRecord(parsed)) return errorMessage
  // Accept both the raw envelope (`{"type":"error","error":{…}}`) and the
  // SDK-unwrapped inner object (`{"type":"ModelError","message":"…"}`).
  const detail = parsed.type === 'error' && isRecord(parsed.error) ? parsed.error : parsed
  const message = [detail.message, isRecord(detail.error) ? detail.error.message : undefined, detail.detail]
    .find((value): value is string => typeof value === 'string')
  if (message === undefined) return errorMessage
  const type = typeof detail.type === 'string' ? detail.type : 'Error'
  const code = typeof detail.code === 'string' ? detail.code : ''
  if (AUTH_ERROR_TYPES.has(type) || AUTH_ERROR_TYPES.has(code)) return errorMessage
  // Dropping the status prefix is what defeats the AUTH classifier.
  return `[opencode-zen ${type}] ${message}`
}

// Required by the adapter, unused by this route: the credential comes from
// `resolveApiKey`, so pi-ai never stores one nor asks an ambient question.
const PI_AUTH: { credentials: CredentialStore, authContext: AuthContext } = {
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async (_providerId, mutate) => mutate(undefined),
    delete: async () => {},
  },
  authContext: { env: async () => undefined, fileExists: async () => false },
}

const sanitizeStream = <S extends { push(event: unknown): void }>(stream: S): S => {
  const originalPush = stream.push.bind(stream)
  stream.push = (event: unknown) => {
    if (isRecord(event) && event.type === 'error' && isRecord(event.error) && typeof event.error.errorMessage === 'string') {
      event.error.errorMessage = rewriteRefusalMessage(event.error.errorMessage)
    }
    originalPush(event)
  }
  return stream
}

const zenApi = {
  stream: (model: Model<'openai-completions'>, context: PiContext, options: SimpleStreamOptions) =>
    sanitizeStream(piAgentStream({ ...model, headers: zenApiHeaders(model, context, options) }, normalizeReasoningContext(context), options)),
  streamSimple: (model: Model<'openai-completions'>, context: PiContext, options: SimpleStreamOptions) =>
    sanitizeStream(piAgentStreamSimple({ ...model, headers: zenApiHeaders(model, context, options) }, normalizeReasoningContext(context), options)),
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (!isRecord(payload)) throw new Error(`${url}: unexpected response shape`)
  return payload
}

/** pi-ai's standard ladder keys (off = explicit close; the rest are depths). */
const PI_LEVEL_KEYS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// Only an `effort`-type option's values shape the selector. A `toggle`, an empty
// list or a missing entry declares no level — an honest "takes no effort".
function reasoningLevelsFor(metadata: Record<string, unknown>): string[] {
  const option = (Array.isArray(metadata.reasoning_options) ? metadata.reasoning_options : [])
    .find(value => isRecord(value) && value.type === 'effort')
  return isRecord(option) && Array.isArray(option.values)
    ? option.values.filter((value): value is string => typeof value === 'string')
    : []
}

// `Default` (the harness's "no selection" path) is the *absent key* — leaving
// `reasoning_effort` off the wire and letting the upstream choose. Each ladder
// level the endpoint accepts lands at its own key with its own wire value; the
// `off` key carries the upstream's literal close value when the feed names one
// (e.g. `none`), so the selector's "Off" entry is a real switch rather than a
// no-op.
function reasoningMapFor(levels: readonly string[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = {}
  for (const key of PI_LEVEL_KEYS) {
    if (levels.includes(key)) map[key] = key
  }
  const closeValue = levels.includes('none') ? 'none' : 'off'
  map.off = closeValue
  return map
}

// Turn the live-scanned feeds into pi-ai model descriptors.
function buildModels(
  zenData: readonly unknown[],
  modelsById: Record<string, unknown>,
  userAgent: string,
): Model<'openai-completions'>[] {
  const baseModels = getBuiltinModels('opencode')
  return zenData
    .filter((entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry.id === 'string' && entry.id.endsWith('-free'))
    .flatMap((entry): Model<'openai-completions'>[] => {
      const id = entry.id as string
      const metadata = modelsById[id]
      if (!isRecord(metadata)) return []
      const baseCompat = baseModels.find(base => base.id === id)?.compat
      // Models not yet in the pi-ai built-in catalogue still need the Zen-
      // specific maxTokensField ("max_tokens") so the proxy does not reject
      // the request with a 500 when "max_completion_tokens" arrives.
      const compat = baseCompat === undefined
        ? { maxTokensField: 'max_tokens' as const, supportsReasoningEffort: false as const }
        : { ...baseCompat, requiresReasoningContentOnAssistantMessages: false }

      // No ladder upstream ⇒ no selector: `reasoning: false` means "no effort
      // control", never "no thinking".
      const levels = reasoningLevelsFor(metadata)
      const controllable = levels.length > 0

      const limit = isRecord(metadata.limit) ? metadata.limit : undefined
      const input = isRecord(metadata.modalities) && Array.isArray(metadata.modalities.input)
        ? metadata.modalities.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
        : []
      return [{
        id,
        name: typeof metadata.name === 'string' ? metadata.name : id,
        api: 'openai-completions',
        provider: PROVIDER,
        baseUrl: 'https://opencode.ai/zen/v1',
        headers: { 'User-Agent': userAgent, 'HTTP-Referer': 'https://opencode.ai' },
        reasoning: controllable,
        ...(controllable ? { thinkingLevelMap: reasoningMapFor(levels) } : {}),
        input: input.length > 0 ? input : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: id === 'mimo-v2.5-free' ? 1_048_576
          : typeof limit?.context === 'number' ? limit.context : 1_048_576,
        maxTokens: typeof limit?.output === 'number' ? limit.output : 32_768,
        ...(compat ? { compat } : {}),
      }]
    })
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  // One-time: the Zen user-agent the cloned transport forces on every request.
  const opencodeVersion = await resolveOpenCodeVersion()
  const opencodeUserAgent = `opencode/${opencodeVersion}`
  installZenUserAgent(opencodeUserAgent)

  let current: () => Config = () => config
  // Outside the settings-backed config, so a settings snapshot cannot clobber a
  // scan.
  let scanned: Model<'openai-completions'>[] = []

  const buildProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const opts = current()
    const piProvider = createProvider<'openai-completions'>({
      id: PROVIDER,
      name: 'OpenCodeZenFree',
      baseUrl: 'https://opencode.ai/zen/v1',
      auth: { apiKey: { name: 'OpenCodeZenFree', resolve: ({ credential }) => Promise.resolve({
        auth: credential?.key === undefined ? {} : { apiKey: credential.key },
        source: 'OpenCodeZenFree',
      }) } },
      models: scanned,
      api: zenApi,
    })
    const profiles = new Map<string, ResolvedPiAiProviderProfile>([[PROVIDER, {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      apiKeyEnv: credentialRef('OPENCODE_ZEN_FREE_API_KEY'),
      streamIdleTimeoutMs: 300_000,
      maxRequestImageBytes: 20_971_520,
      requestImagePixelBudget: 4_194_304,
      requestImageMaxBytes: 1_048_576,
      retryPolicy: resolveRetryPolicy(opts.retryPolicy, `${name}: retryPolicy`),
      piProvider,
      configuredMaxTokens: new Map(),
    }]])
    return profiles
  }

  // PiAiAdapter memoizes its snapshot on this Map's identity, so a fresh Map per
  // request would rebuild the whole pi-ai collection: rebuild only on change.
  let profiles = buildProfiles()

  const adapter = new PiAiAdapter({
    resolveAttachments: () => ctx.get('attachments'),
    profiles: () => profiles,
    auth: PI_AUTH,
    resolveApiKey: async (_provider, profile) => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const hit = await credentials.resolve(profile.apiKeyEnv!)
        if (hit !== undefined) return assertUsableApiKey(hit.value, name, String(profile.apiKeyEnv))
      }
      // OpenCode Zen accepts the public route without a user API key.
      return 'public'
    },
  })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      profiles = buildProfiles()
    },
  })

  // The catalog is fetched once at mount. Mount never awaits it: an unreachable
  // upstream must not kill the plugin.
  async function sync(): Promise<void> {
    const [zen, modelsDev] = await Promise.all([
      fetchJson('https://opencode.ai/zen/v1/models', {
        'User-Agent': opencodeUserAgent,
        accept: 'application/json',
      }),
      fetchJson('https://models.dev/api.json', { accept: 'application/json' }),
    ])
    if (!Array.isArray(zen.data)) throw new Error('zen models: unexpected response shape')
    if (!isRecord(modelsDev.opencode) || !isRecord(modelsDev.opencode.models)) {
      throw new Error('models.dev: no "opencode" provider')
    }
    const next = buildModels(zen.data, modelsDev.opencode.models, opencodeUserAgent)
    if (next.length === 0) {
      throw new Error('no OpenCode Zen free models resolved; keeping the previous catalog')
    }
    if (deepEqualJson(next, scanned)) return
    scanned = next
    profiles = buildProfiles()
    ctx.logger.info('[%s] synced %d free model(s): %s', name, scanned.length, scanned.map(model => model.id).join(', '))
  }

  void sync().catch((error: unknown) => {
    ctx.logger.warn('[%s] initial catalog scan failed: %s', name, errorChain(error))
  })
}
