/**
 * G4/V4: LLM-driven reasoning for the three agents. Each agent's model gets tools for its
 * OWN database only and never sees another agent's data in its prompt. The model PROPOSES
 * (a retrieval plan, match terms); code checks the proposal and owns numbers, evidence,
 * risk and every write. When no provider is configured or a call fails, the caller falls
 * back to the scripted behaviour (kept for the no-AI path and for tests).
 */
import { getProvider, withTimeout } from '../llm.js';
import type { ToolCall, ToolDecl, Turn } from '../llm.js';

/** True when a real (or test) provider is configured; false = scripted fallback. */
export function archLlmEnabled(): boolean {
  try { return getProvider().isConfigured(); } catch { return false; }
}

/** Which provider the agents' reasoning runs on ('mock (tests only)', 'gemini', 'openai'),
 *  or null when scripted. The UI must show this: 'model' on the mock is wiring, not quality. */
export function archLlmProviderName(): string | null {
  try { const p = getProvider(); return p.isConfigured() ? p.name : null; } catch { return null; }
}

interface AgentRunArgs {
  agent: 'cm' | 'nordea' | 'personal';
  system: string;
  prompt: string;
  /** Tools scoped to the agent's own store, plus exactly one finish* tool. */
  tools: ToolDecl[];
  runTool: (call: ToolCall) => unknown;
  finishTool: string;
}

/**
 * One bounded tool-calling loop: the model reads its own store through the read tools and
 * MUST end with the finish tool, whose args are the proposal. Returns the finish args, or
 * null on any failure (caller falls back to the scripted path).
 */
/** One agent reasoning run: the model's proposal, or why there is none (truthful status). */
export interface PlanOutcome<T> { plan: T | null; status: 'model' | 'scripted' | 'error'; error?: string }

export async function runAgentReasoning(args: AgentRunArgs): Promise<{ result: Record<string, unknown> | null; error?: string }> {
  const provider = getProvider();
  const turns: Turn[] = [{ role: 'user', text: args.prompt }];
  for (let step = 0; step < 4; step++) {
    let r;
    try {
      r = await withTimeout(
        provider.step({ system: args.system, turns, tools: args.tools, temperature: 0, timeoutMs: 15000 }),
        20000, `${args.agent} agent reasoning`);
    } catch (e) { return { result: null, error: e instanceof Error ? e.message : String(e) }; }
    if (!r.calls.length) return { result: null };
    for (const call of r.calls) {
      if (call.name === args.finishTool) return { result: (call.args ?? {}) as Record<string, unknown> };
    }
    turns.push({ role: 'model_calls', calls: r.calls, raw: r.raw }); // keep raw parts: Gemini 3.x needs thought_signature echoed back
    turns.push({ role: 'tool_results', results: r.calls.map((call) => ({ call, result: args.runTool(call) })) });
  }
  return { result: null };
}

/** Validation helpers: the model proposes, code checks. */
export const cleanTerms = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.toLowerCase().trim())
    .filter((t) => /^[a-z0-9][a-z0-9 -]{1,29}$/.test(t))
    .slice(0, max);
