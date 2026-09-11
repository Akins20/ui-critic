import { GeminiClient, listModels as listGeminiModels } from "./gemini.mjs";
import { OpenAIClient, listModels as listOpenAIModels } from "./openai.mjs";

/**
 * Which critic answers: the configured provider, or one inferred from the model
 * id (gpt-* and o-series ids are OpenAI, everything else Gemini). Both providers
 * expose the same client surface, so the rest of the tool never knows which one
 * it is talking to.
 */
export function providerFor(config) {
  if (config.provider) return config.provider;
  return /^(gpt-|o\d|chatgpt)/i.test(String(config.model ?? "")) ? "openai" : "gemini";
}

/** A client for the configured provider, bound to one model and one run. */
export function createClient(config, { ledgerPath, runLabel }) {
  const provider = providerFor(config);
  const options = {
    model: config.model,
    thinking: config.thinking,
    generation: config.generation,
    cache: config.cache,
    pricing: config.pricing,
    ledgerPath,
    runLabel,
  };
  return provider === "openai" ? new OpenAIClient(options) : new GeminiClient(options);
}

/** The vision-capable generation models the configured provider offers for the key. */
export async function listModels(config, filter) {
  return providerFor(config) === "openai" ? listOpenAIModels(filter) : listGeminiModels(filter);
}
