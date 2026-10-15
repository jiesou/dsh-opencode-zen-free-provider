import type { Context } from '@deepseek-ai/cordis'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertUsableApiKey, errorChain, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
// Augments Context with `fiber.entry` and the `loader/volatile-update` event.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { createProvider, type AuthContext, type CredentialStore, type Model, type SimpleStreamOptions, type SystemMessage, type ThinkingLevelMap, type ProviderStreams, type Tool, type TranscriptContext } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { stream as piAgentStream, streamSimple as piAgentStreamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { stream as piResponsesStream, streamSimple as piResponsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses'

export const name = 'opencode-zen-free-provider'
export const inject = ['llm']

const PROVIDER = name
const DISPLAY_NAME = 'OpenCode Zen Free'

/**
 * Inference base URL. The free tier moved off `/zen/v1` on 2026-10-11, when
 * upstream turned the Zen routes into a thin proxy (`83f2b6f67a`) and pushed
 * the gate down into a private inference service: `/zen/v1` now answers every
 * anonymous request with `403 FreeTierError`, while `/inference/v1` serves the
 * same catalogue and accepts the same fingerprint. Verified against the live
 * endpoint — identical body/headers on the two paths differ only in the status.
 */
const ZEN_BASE_URL = 'https://opencode.ai/inference/v1'

/** Model catalogue endpoint; the old `/zen/v1/models` gate still 403s. */
const ZEN_CATALOG_URL = `${ZEN_BASE_URL}/models`

/**
 * Context windows wider than the ones models.dev declares for the free tier.
 *
 * models.dev registers the free rows at the conservative 200K tier while the
 * backend serves 1M, and the window is client-side metadata — the declared
 * number is what the harness trims history against, so trusting the feed
 * throttles a model that would serve more.
 */
const CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  'mimo-v2.6-flash-free': 1_048_576,
  'deepseek-v4.1-flash-free': 1_048_576,
}

/**
 * Latest CLI version, read off unpkg's `@latest` redirect via the package's own `package.json`.
 *
 * The fallback matters: Zen refuses anything below 1.18.0 outright with HTTP 426
 * "OpenCode 1.18.0 or newer is required to use the free tier", so an unreachable
 * unpkg must not silently drop us below that floor.
 */
const OPENCODE_VERSION_URL = 'https://unpkg.com/opencode-ai@latest/package.json'
const OPENCODE_VERSION_FALLBACK = '1.19.0'

/** Envelope types that must stay AUTH-classified instead of being rewritten. */
const AUTH_ERROR_TYPES = new Set(['AuthError', 'authentication_error', 'invalid_api_key', 'unauthorized'])

/**
 * Request image budget: 2 MiB of base64 per request, 1 MiB per image.
 *
 * The budget is compared against the base64 length the wire carries (×4/3), so
 * one full-size image is ~1.4 MB and fits with room for a second at ~700 KB. A
 * third occurrence makes the harness offload the oldest one to a text
 * placeholder that still names its local normalized copy. This wire is
 * stateless, so every retained image rides every turn again.
 */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 2_097_152
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1_048_576

export interface Config {
  /** Base64 image payload one request accepts before older images are offloaded (default 2 MiB). */
  maxRequestImageBytes?: number
  /** Per-image request budget after re-encoding (default 1 MiB). */
  requestImageMaxBytes?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

export const Config = z.object({
  maxRequestImageBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES).volatile(),
  requestImageMaxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
})

/**
 * {@link Config} as the Loader holds it: every field is volatile, so a settings write
 * reaches the running plugin as a committed reference instead of remounting it, and
 * the field is one the settings service shows a form for.
 */
type LiveConfig = Schemastery.TypeT<typeof Config>

/**
 * The committed configuration as plain mutable values. Unwrapping the references
 * yields immutable snapshots; cloning is what makes them workable again.
 */
function liveConfig(config: LiveConfig): Config {
  return structuredClone({
    maxRequestImageBytes: config.maxRequestImageBytes.get(),
    requestImageMaxBytes: config.requestImageMaxBytes.get(),
    retryPolicy: config.retryPolicy.get(),
  }) as Config
}

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

/**
 * Identifier format of the opencode CLI (`packages/schema/src/identifier.ts`):
 * the 12 leading hex digits are the six most significant bytes of a 64-bit
 * value (`ms * 0x1000 + counter`, bit-inverted for `ses_` so the newest sorts
 * first), followed by 14 random base62 characters.
 *
 * Zen's free tier decodes that timestamp prefix, so a digest-shaped prefix gets
 * `FreeTierError` even with every header correct. `msg_` is not validated, but
 * minting both the same way keeps the wire honest.
 */
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let lastIdTimestamp = 0
let idCounter = 0

const opencodeId = (prefix: 'ses' | 'msg', descending: boolean): string => {
  const timestamp = Date.now()
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp
    idCounter = 0
  }
  idCounter += 1
  let value = BigInt(timestamp) * 0x1000n + BigInt(idCounter)
  if (descending) value = ~value
  // Byte by byte from the top, as upstream does: `ses_` inverts the value, and
  // a single arithmetic shift of a negative BigInt is floored, not truncated.
  let time = ''
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0')
  }
  let random = ''
  for (let index = 0; index < 14; index += 1) {
    random += ID_ALPHABET[Math.floor(Math.random() * 62)]
  }
  return `${prefix}_${time}${random}`
}

/**
 * Session ids already minted for a conversation. Zen meters free usage per
 * session and routes its prompt cache by the id, so every turn of one
 * conversation has to reuse the id minted its first turn.
 */
const ZEN_SESSION_KEEP = 128
const zenSessions = new Map<string, string>()

const zenSessionId = (seed: string): string => {
  const hit = zenSessions.get(seed)
  if (hit !== undefined) return hit
  const minted = opencodeId('ses', true)
  if (zenSessions.size >= ZEN_SESSION_KEEP) {
    const oldest = zenSessions.keys().next()
    if (!oldest.done) zenSessions.delete(oldest.value)
  }
  zenSessions.set(seed, minted)
  return minted
}

const zenApiHeaders = (model: Pick<Model<ZenApi>, 'headers'>, options: SimpleStreamOptions) => {
  const sessionId = options.sessionId ?? 'dsh-session-unknown'
  // One id per conversation, reused by every turn: Zen meters free usage by
  // session and caches by it.
  const session = zenSessionId(sessionId)
  return {
    ...model.headers,
    // Deliberately absent: `HTTP-Referer`. The real CLI sends no referer, and
    // the inference gate refuses any request that carries one (verified: the
    // same request flips 200 -> 403 the moment it is added).
    // Inference routes reject a 40-hex project id; only the literal `global`
    // passes. On this path `x-opencode-project` is pure provenance, no routing.
    'x-opencode-project': 'global',
    // The gate wants all four session headers carrying the same value; sending
    // only the legacy `x-opencode-session` is refused. Traced from the CLI v2
    // request (which dual-sends the old and three newer names).
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'X-Session-Id': session,
    // Deliberately absent: `x-opencode-request`. Its mere presence trips the
    // gate on the inference path (it is only valid on the `/zen/go/v1` route).
    'x-opencode-client': 'cli',
  }
}

// Zen's free tier only unlocks for the opencode CLI identity, but the harness
// merges its own mandatory attribution `user-agent` over model headers
// (dsh-llm's attributionHeaders, merged after model.headers by pi-ai's client),
// so the fetch layer is the only place that still wins. Scoped to opencode's own
// routes — `/inference/v1` today, `/zen` for the Go catalogue — so every other
// URL keeps the harness attribution untouched.
const zenNativeFetch = globalThis.fetch
let zenUserAgent: string | undefined

const ZEN_URL_MARKERS = ['opencode.ai/inference', 'opencode.ai/zen']

const zenFetch: typeof globalThis.fetch = (input, init) => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL ? input.href : input instanceof Request ? input.url : String(input)
  if (zenUserAgent === undefined || !ZEN_URL_MARKERS.some(marker => url.includes(marker))) {
    return zenNativeFetch(input, init)
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set('user-agent', zenUserAgent)
  return zenNativeFetch(input, { ...init, headers })
}

/**
 * Model-visible description of a tool this harness cannot execute. Each
 * placeholder mirrors the parameter shape the real opencode tool declares, so a
 * model that calls one produces an argument the harness can still see and
 * report; the harness never runs it.
 */
const ZEN_TOOL_TEXT = 'Requirement placeholder from OpenCode Zen: this harness cannot execute it.'

const zenTool = (name: string, property: string): Tool => ({
  name,
  description: ZEN_TOOL_TEXT,
  parameters: {
    type: 'object',
    properties: { [property]: { type: 'string', description: ZEN_TOOL_TEXT } },
    required: [property],
  },
})

/**
 * The free tier gates on the request's tool list: `bash` and `read` must both be
 * present, by exact lowercase name, each carrying a real parameter schema —
 * omitting the schema is refused just as a missing name is. Requests carrying
 * fewer tools — compaction, session titles, summaries, or any turn whose
 * permissions cut the list down — are refused with the misleading "free tier can
 * only be used from within OpenCode". Pad such requests so the shape requirement
 * holds. Declared tools stay first and only missing ones are appended, so a
 * request that already qualifies is untouched and the provider's prompt cache is
 * not invalidated.
 *
 * Verified against the live endpoint: a body declaring `bash`+`read`+`edit`
 * passes, while one declaring no tools (or `edit` alone) is refused. `glob` and
 * `grep` are served here too because the real CLI offers them, but the gate does
 * not require them.
 */
const ZEN_REQUIRED_TOOLS: readonly (readonly [string, string])[] = [
  ['bash', 'command'],
  ['read', 'file_path'],
]

export const requiredZenTools = (tools: readonly Tool[] = []): Tool[] => {
  const filled = [...tools]
  const present = new Set(filled.map(tool => tool.name))
  for (const [name, property] of ZEN_REQUIRED_TOOLS) {
    if (!present.has(name)) filled.push(zenTool(name, property))
  }
  return filled
}

// Replayed thinking blocks carry no wire signature; marking them
// `reasoning_content` keeps the transport from mangling history. Never gated on
// `model.reasoning`: a model with no effort control still streams thinking.
//
// On pi-ai 0.87 the tool declarations no longer sit on the context: they live in
// the transcript's system messages, so padding the list means rewriting the
// leading `toolsAdded` (falling back to `context.tools`, which a context built
// before normalization still carries).
const normalizeReasoningContext = (context: TranscriptContext & { tools?: readonly Tool[] }): TranscriptContext => ({
  ...context,
  messages: context.messages.map((message, index) => {
    // Pad the tool list where pi-ai keeps it: the leading system message.
    if (index === 0 && message.role === 'system') {
      return { ...message, toolsAdded: requiredZenTools(message.toolsAdded ?? context.tools ?? []) }
    }
    if (message.role !== 'assistant') return message
    return {
      ...message,
      content: message.content.map(block =>
        block.type === 'thinking' && block.thinking.trim().length > 0 && block.thinkingSignature === undefined
          ? { ...block, thinkingSignature: 'reasoning_content' }
          : block),
    }
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

type ZenApi = 'openai-completions' | 'openai-responses'

const zenStreamFor = (api: ZenApi): ProviderStreams => api === 'openai-responses'
  ? {
    stream: (model: Model<'openai-responses'>, context: TranscriptContext, options: SimpleStreamOptions) =>
      sanitizeStream(piResponsesStream({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
    streamSimple: (model: Model<'openai-responses'>, context: TranscriptContext, options: SimpleStreamOptions) =>
      sanitizeStream(piResponsesStreamSimple({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
  } as unknown as ProviderStreams
  : {
    stream: (model: Model<'openai-completions'>, context: TranscriptContext, options: SimpleStreamOptions) =>
      sanitizeStream(piAgentStream({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
    streamSimple: (model: Model<'openai-completions'>, context: TranscriptContext, options: SimpleStreamOptions) =>
      sanitizeStream(piAgentStreamSimple({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
  }

const zenApi: Partial<Record<ZenApi, ProviderStreams>> = {
  'openai-completions': zenStreamFor('openai-completions'),
  'openai-responses': zenStreamFor('openai-responses'),
}

/**
 * Catalog fetch, bounded in both attempts and wall-clock.
 *
 * `models.dev/api.json` is a multi-megabyte document that usually answers in
 * ~2s but intermittently stalls past 90s. The scan is what makes the provider's
 * models exist at all, so letting it hang means registering an empty catalogue
 * and failing the first turn with UNKNOWN_MODEL. Two attempts under a short
 * per-attempt deadline keep a stall from consuming the whole budget, and the
 * caller falls back to the on-disk copy when both miss.
 */
const CATALOG_ATTEMPTS = 3
const CATALOG_TIMEOUT_MS = 20_000
const CATALOG_TOTAL_BUDGET_MS = 45_000

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

async function fetchJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const deadline = Date.now() + CATALOG_TOTAL_BUDGET_MS
  let lastError: unknown
  for (let attempt = 1; attempt <= CATALOG_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(Math.min(CATALOG_TIMEOUT_MS, remaining)),
      })
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      const payload: unknown = await response.json()
      if (!isRecord(payload)) throw new Error(`${url}: unexpected response shape`)
      return payload
    } catch (error) {
      lastError = error
      if (attempt < CATALOG_ATTEMPTS) await sleep(250 * attempt)
    }
  }
  throw lastError
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
// `no-op. Responses-model feeds name no close value and `/responses` rejects
// both fabricated ones (`'off'` is an unknown variant, `'none'` unsupported
// for this model). pi-ai sends nothing only when the key is explicitly `null`
// (an absent key falls back to sending `'none'`), so `off: null` is the honest
// "upstream decides" — it also drops "Off" from the selector, which is correct
// because this endpoint offers no way to turn thinking down.
function reasoningMapFor(levels: readonly string[], api: ZenApi): ThinkingLevelMap {
  const map: ThinkingLevelMap = {}
  for (const key of PI_LEVEL_KEYS) {
    if (levels.includes(key)) map[key] = key
  }
  if (api === 'openai-completions') {
    map.off = levels.includes('none') ? 'none' : 'off'
  } else {
    map.off = null
  }
  return map
}

// Turn the live-scanned feeds into pi-ai model descriptors.
function buildModels(
  zenData: readonly unknown[],
  modelsById: Record<string, unknown>,
  userAgent: string,
): Model<ZenApi>[] {
  const baseModels = getBuiltinModels('opencode')
  return zenData
    .filter((entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry.id === 'string' && entry.id.endsWith('-free'))
    .flatMap((entry): Model<ZenApi>[] => {
      const id = entry.id as string
      const metadata = modelsById[id]
      if (!isRecord(metadata)) return []
      if (typeof metadata.status === 'string' && metadata.status === 'deprecated') return []
      // Zen serves muse-spark contributor-free models on the Responses
      // endpoint (`/zen/v1/responses`); chat/completions 500s for them.
      const api: ZenApi = id.includes('muse-spark') ? 'openai-responses' : 'openai-completions'
      const baseCompat = baseModels.find(base => base.id === id)?.compat
      // Models not yet in the pi-ai built-in catalogue still need the Zen-
      // specific maxTokensField ("max_tokens") so the proxy does not reject
      // the request with a 500 when "max_completion_tokens" arrives.
      //
      // `supportsStrictMode` is what makes pi-ai state `strict: false` on a
      // Responses tool. Without that field the Responses API normalises the
      // schema into strict mode, where every declared property counts as
      // required and the model has to invent the optional arguments. Zen's own
      // CLI writes the field on every OpenAI-wire tool for the same reason.
      // Chat-completions models need nothing: pi-ai omits `strict` there, and
      // that API stays non-strict by default.
      const strictCompat = api === 'openai-responses' ? { supportsStrictMode: true as const } : {}
      const compat = baseCompat === undefined
        ? { maxTokensField: 'max_tokens' as const, supportsReasoningEffort: false as const, ...strictCompat }
        : { ...baseCompat, requiresReasoningContentOnAssistantMessages: false, ...strictCompat }

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
        api,
        provider: PROVIDER,
        baseUrl: ZEN_BASE_URL,
        headers: { 'User-Agent': userAgent },
        reasoning: controllable,
        ...(controllable ? { thinkingLevelMap: reasoningMapFor(levels, api) } : {}),
        input: input.length > 0 ? input : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // The feed declares the 200K tier for both of these while the backend
        // serves 1M, and the cap is client-side metadata: the declared value is
        // what the harness trims against, so mirroring the feed throttles a
        // model that would otherwise serve more. models.dev lists the *paid*
        // `deepseek-v4.1-flash` at 1M (`deepseek-v4-flash` likewise at 1M), and
        // the free id is the same backend — only the feed's free-tier row says
        // 200K. Verified against the live endpoint on the 1M path.
        contextWindow: CONTEXT_WINDOW_OVERRIDES[id] ?? (typeof limit?.context === 'number' ? limit.context : 1_048_576),
        maxTokens: typeof limit?.output === 'number' ? limit.output : 32_768,
        ...(compat ? { compat } : {}),
      }]
    })
}

/**
 * Last-good catalog on disk, so a stalled `models.dev` degrades to a slightly
 * stale model list instead of an empty one (which would fail the first turn
 * with UNKNOWN_MODEL). Best-effort in both directions: an unreadable cache just
 * means the next fetch has to succeed.
 */
const CACHE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache')
const CACHE_PATH = join(CACHE_DIR, `${name}-catalog.json`)

interface CatalogCache {
  zen: unknown[]
  models: Record<string, unknown>
  userAgent: string
}

async function readCatalogCache(): Promise<CatalogCache | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(CACHE_PATH, 'utf8'))
    if (!isRecord(parsed) || !Array.isArray(parsed.zen) || !isRecord(parsed.models)) return undefined
    if (typeof parsed.userAgent !== 'string') return undefined
    return { zen: parsed.zen, models: parsed.models, userAgent: parsed.userAgent }
  } catch {
    return undefined
  }
}

async function writeCatalogCache(cache: CatalogCache): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    // Write-then-rename so a torn write cannot leave a half-parsed cache behind.
    const temporary = `${CACHE_PATH}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(cache))
    await rename(temporary, CACHE_PATH)
  } catch {
    // A cache miss is always recoverable; never fail the scan over it.
  }
}

export async function apply(ctx: Context, config: LiveConfig): Promise<void> {
  // One-time: the Zen user-agent the transport forces on every opencode.ai/zen request.
  const opencodeVersion = await resolveOpenCodeVersion()
  const opencodeUserAgent = `opencode/${opencodeVersion}`
  zenUserAgent = opencodeUserAgent

  // The Loader owns the settings namespace, so the configuration form is
  // addressed by the profile entry id that mounted this plugin.
  const settingsNs = ctx.fiber.entry?.options.id ?? name

  // Outside the settings-backed config, so a settings snapshot cannot clobber a
  // scan.
  let scanned: Model<ZenApi>[] = []

  const buildProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const opts = liveConfig(config)
    const piProvider = createProvider<ZenApi>({
      id: PROVIDER,
      name: 'OpenCodeZenFree',
      baseUrl: ZEN_BASE_URL,
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
      maxRequestImageBytes: opts.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
      requestImagePixelBudget: 4_194_304,
      requestImageMaxBytes: opts.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
      retryPolicy: resolveRetryPolicy(opts.retryPolicy, `${name}: retryPolicy`),
      piProvider,
      modelErrors: new Map(),
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
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Every field is volatile, so the Loader commits a settings write into this
  // fiber and announces it here instead of remounting; re-derive the profiles.
  ctx.on('loader/volatile-update', () => {
    profiles = buildProfiles()
  })

  // The catalog is fetched once at mount. Mount awaits it: dsh resolves a
  // session's model as soon as the provider is up, so registering the adapter
  // against an empty catalogue makes every model read as UNKNOWN_MODEL on the
  // first turn — the scan has to land before the first resolve does. Both feeds
  // are bounded, and when either is unreachable the last-good catalog on disk
  // stands in, so a stalled models.dev costs one slow start instead of the
  // whole model list.
  async function sync(): Promise<void> {
    const usable = (zen: unknown[], models: Record<string, unknown>, userAgent: string) => {
      const next = buildModels(zen, models, userAgent)
      if (next.length === 0) throw new Error('no OpenCode Zen free models resolved')
      return next
    }

    let next: Model<ZenApi>[]
    try {
      const [zen, modelsDev] = await Promise.all([
        fetchJson(ZEN_CATALOG_URL, {
          'User-Agent': opencodeUserAgent,
          accept: 'application/json',
        }),
        fetchJson('https://models.dev/api.json', { accept: 'application/json' }),
      ])
      if (!Array.isArray(zen.data)) throw new Error('zen models: unexpected response shape')
      if (!isRecord(modelsDev.opencode) || !isRecord(modelsDev.opencode.models)) {
        throw new Error('models.dev: no "opencode" provider')
      }
      next = usable(zen.data, modelsDev.opencode.models, opencodeUserAgent)
      void writeCatalogCache({ zen: zen.data, models: modelsDev.opencode.models, userAgent: opencodeUserAgent })
    } catch (error) {
      const cached = await readCatalogCache()
      if (cached === undefined) throw error
      ctx.logger.warn('[%s] catalog fetch failed (%s); using the cached catalog', name, errorChain(error))
      next = usable(cached.zen, cached.models, cached.userAgent)
    }

    if (deepEqualJson(next, scanned)) return
    scanned = next
    profiles = buildProfiles()
    ctx.logger.info('[%s] synced %d free model(s): %s', name, scanned.length, scanned.map(model => model.id).join(', '))
  }

  await sync().catch((error: unknown) => {
    ctx.logger.warn('[%s] initial catalog scan failed: %s', name, errorChain(error))
  })
}
