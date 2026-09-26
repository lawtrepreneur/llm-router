/**
 * Typed HTTP adapter for the decider-4b classifier served by llama-swap
 * (Issue #17 / #18). The model reads a state plus typed questions and returns
 * a probability distribution over option letters from the logprobs at the
 * answer slot — no decoding, no Jev dependency.
 *
 * Fail-safe contract: every failure path raises DeciderError; the caller falls
 * back to the native deterministic route. Partial probabilities are never
 * returned.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DeciderConfig {
  /** Completions endpoint. Defaults to DECIDER_ENDPOINT env, then llama-swap. */
  endpoint?: string;
  /** Model alias served by llama-swap. Default "decider". */
  model?: string;
  /** decider-4b v2.1 choice temperature (decider_config.json). Default 1.11. */
  temperature?: number;
  /** Timeout in ms for each HTTP call. Default 5000. */
  timeoutMs?: number;
}

function resolveConfig(cfg: DeciderConfig = {}): Required<DeciderConfig> {
  return {
    endpoint: cfg.endpoint ?? process.env.DECIDER_ENDPOINT ?? "http://127.0.0.1:8914/v1/completions",
    model: cfg.model ?? "decider",
    temperature: cfg.temperature ?? 1.11,
    timeoutMs: cfg.timeoutMs ?? 5_000,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DeciderError extends Error {
  readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(`[decider] ${message}`);
    this.name = "DeciderError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Questions & answers
// ---------------------------------------------------------------------------

export interface DeciderQuestion {
  question: string;
  /** 2..10 options, mapped to option letters (A)…(J). */
  options: string[];
}

export interface DeciderAnswer {
  question: string;
  /** Argmax option text. */
  choice: string;
  /** Softmax over option letters, aligned with the options array order. */
  probabilities: number[];
  maxProbability: number;
}

const LETTERS = "ABCDEFGHIJ".split("");

// ---------------------------------------------------------------------------
// Prompt builder (state-first "plain" layout, decider/prompt.py conventions)
// ---------------------------------------------------------------------------

export function buildDeciderPrompt(taskText: string, questions: DeciderQuestion[]): string {
  if (!taskText.trim()) throw new DeciderError("task text must be non-empty");
  if (questions.length === 0) throw new DeciderError("at least one question required");
  for (const q of questions) {
    if (q.options.length < 2 || q.options.length > 10) {
      throw new DeciderError(`question "${q.question}" needs 2..10 options, got ${q.options.length}`);
    }
  }
  let prompt = `Context:\n${taskText}`;
  questions.forEach((q, k) => {
    const num = questions.length > 1 ? ` ${k + 1}` : "";
    prompt += `\n\nQuestion${num}: ${q.question}\nOptions:`;
    q.options.forEach((opt, j) => {
      prompt += `\n(${LETTERS[j]}) ${opt}`;
    });
  });
  questions.forEach((q, k) => {
    const num = questions.length > 1 ? ` ${k + 1}` : "";
    prompt += `\nAnswer${num}: (`;
  });
  return prompt;
}

// ---------------------------------------------------------------------------
// Parse (pure — no I/O, unit-testable)
// ---------------------------------------------------------------------------

interface TopLogprob { token: string; logprob: number }

export function parseDeciderLogprobs(response: unknown, questions: DeciderQuestion[]): DeciderAnswer[] {
  const content = (response as { choices?: { logprobs?: { content?: { top_logprobs?: TopLogprob[] }[] } }[] })
    ?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
  if (!Array.isArray(content)) throw new DeciderError("malformed response");
  // The answer slot reads exactly one question per request in our routing use.
  const q = questions[0];
  const valid = new Set(LETTERS.slice(0, q.options.length));
  const seen = content.filter(t => valid.has(t?.token));
  if (seen.length === 0) throw new DeciderError("no option-letter tokens in top_logprobs");
  // Unseen options get logprob -Infinity (probability 0 after softmax).
  const logits = q.options.map((_, j) => {
    const hit = seen.find(t => t.token === LETTERS[j]);
    return hit ? hit.logprob / 1 : -Infinity;
  });
  return [softmax(logits, q)];
}

function softmax(logits: number[], q: DeciderQuestion): DeciderAnswer {
  const max = Math.max(...logits);
  const exps = logits.map(l => (l === -Infinity ? 0 : Math.exp(l - max)));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sum);
  const argmax = probs.indexOf(Math.max(...probs));
  return {
    question: q.question,
    choice: q.options[argmax],
    probabilities: probs,
    maxProbability: probs[argmax],
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export async function callDecider(taskText: string, questions: DeciderQuestion[], cfg?: DeciderConfig): Promise<DeciderAnswer[]> {
  const config = resolveConfig(cfg);
  const answers: DeciderAnswer[] = [];
  // One HTTP request per question; llama-server prompt caching makes the
  // shared Context prefix cheap. Routing asks a single 3-option question.
  for (const q of questions) {
    const prompt = buildDeciderPrompt(taskText, [q]);
    let response: Response;
    try {
      response = await fetch(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          prompt,
          max_tokens: 1,
          temperature: 0,
          n_probs: 20,
          cache_prompt: true,
          logprobs: true,
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      throw new DeciderError(err instanceof Error && err.name === "TimeoutError" ? "timeout" : "endpoint unreachable", err instanceof Error ? err : undefined);
    }
    if (!response.ok) throw new DeciderError(`HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new DeciderError("malformed response", err as Error);
    }
    const parsed = parseDeciderLogprobs(body, [q]);
    // Temperature applied here: logits already raw logprobs from the model;
    // parseDeciderLogprobs keeps raw ordering, we rescale by dividing logprobs.
    answers.push(applyTemperature(parsed[0], config.temperature));
  }
  return answers;
}

function applyTemperature(answer: DeciderAnswer, temperature: number): DeciderAnswer {
  // Re-softmax the returned probabilities at the decider temperature by
  // recovering logits from probabilities, dividing, then renormalising.
  const logits = answer.probabilities.map(p => (p === 0 ? -Infinity : Math.log(p)));
  const scaled = logits.map(l => (l === -Infinity ? -Infinity : l / temperature));
  const max = Math.max(...scaled);
  const exps = scaled.map(l => (l === -Infinity ? 0 : Math.exp(l - max)));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sum);
  const argmax = probs.indexOf(Math.max(...probs));
  return { ...answer, probabilities: probs, maxProbability: probs[argmax], choice: answer.choice };
}