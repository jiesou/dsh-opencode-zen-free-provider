import type { Context } from '@deepseek-ai/cordis';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { type Tool } from '@earendil-works/pi-ai';
export declare const name = "opencode-zen-free-provider";
export declare const inject: string[];
export interface Config {
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, "plain">;
/**
 * {@link Config} as the Loader holds it: every field is volatile, so a settings write
 * reaches the running plugin as a committed reference instead of remounting it, and
 * the field is one the settings service shows a form for.
 */
type LiveConfig = Schemastery.TypeT<typeof Config>;
/**
 * Zen's free tier is gated on the request fingerprint, and one of the checks is
 * the tool list: it must offer at least two distinct tools, `bash` among them,
 * alongside `stream: true` (both transports hardcode that). Requests that carry
 * fewer tools — compaction, session titles, summaries, or any turn whose
 * permissions cut the list down — are refused with FreeTierError and the
 * misleading "free tier can only be used from within OpenCode". Pad such
 * requests so the shape requirement holds. Declared tools stay first and only
 * missing ones are appended, so a request that already qualifies is untouched
 * and the provider's prompt cache is not invalidated.
 */
export declare const requiredZenTools: (tools?: readonly Tool[]) => Tool[];
export declare function apply(ctx: Context, config: LiveConfig): Promise<void>;
export {};
