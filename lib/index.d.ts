import type { Context } from '@deepseek-ai/cordis';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { type Tool } from '@earendil-works/pi-ai';
export declare const name = "opencode-zen-free-provider";
export declare const inject: string[];
export interface Config {
    /** Base64 image payload one request accepts before older images are offloaded (default 2 MiB). */
    maxRequestImageBytes?: number;
    /** Per-image request budget after re-encoding (default 1 MiB). */
    requestImageMaxBytes?: number;
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    maxRequestImageBytes: z<number, number, "volatile-defined">;
    requestImageMaxBytes: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    maxRequestImageBytes: z<number, number, "volatile-defined">;
    requestImageMaxBytes: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, "plain">;
/**
 * {@link Config} as the Loader holds it: every field is volatile, so a settings write
 * reaches the running plugin as a committed reference instead of remounting it, and
 * the field is one the settings service shows a form for.
 */
type LiveConfig = Schemastery.TypeT<typeof Config>;
/**
 * A replayed assistant message carries the model's reasoning field even when
 * that turn produced no reasoning — the shape opencode's own client sends.
 *
 * `lowerAssistantMessage` (opencode `packages/ai/src/protocols/openai-chat.ts`)
 * picks the field name from the model's declared reasoning field and writes `""`
 * for an assistant turn with no reasoning part whenever the model requires one;
 * `requireReasoning` follows a declared field, so every free id qualifies —
 * models.dev declares `interleaved.field` for all of them. Zen's backend that
 * validates this refuses the divergent shape with "The reasoning_content in the
 * thinking mode must be passed back to the API".
 *
 * pi-ai pads the same way through `compat.requiresReasoningContentOnAssistantMessages`
 * (declared on every model below), but that path is gated on `model.reasoning`,
 * and a model with no declared effort ladder is `reasoning: false` here — no
 * picker, which is not the same as no thinking. Those ids still replay real
 * reasoning out of their thinking blocks, so their missing fields are filled
 * here instead.
 */
export declare const withReplayedReasoning: (body: string, modelIds: ReadonlySet<string>) => string;
export declare const requiredZenTools: (tools?: readonly Tool[]) => Tool[];
export declare function apply(ctx: Context, config: LiveConfig): Promise<void>;
export {};
