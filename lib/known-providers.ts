/**
 * Well-known provider model metadata.
 *
 * When a provider appears in the OpenClaw config without full model details
 * (contextWindow, maxTokens, etc.), these presets fill in the gaps so the
 * dashboard can display richer information.
 */

export interface KnownModelMeta {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
}

export interface KnownProviderMeta {
  displayName: string;
  api: string;
  baseUrl: string;
  models: KnownModelMeta[];
}

const KNOWN_PROVIDERS: Record<string, KnownProviderMeta> = {
  minimax: {
    displayName: "MiniMax",
    api: "openai-completions",
    baseUrl: "https://api.minimax.io/v1",
    models: [
      {
        id: "MiniMax-M2.7",
        name: "MiniMax-M2.7",
        contextWindow: 204800,
        maxTokens: 192000,
        reasoning: false,
        input: ["text"],
      },
      {
        id: "MiniMax-M2.7-highspeed",
        name: "MiniMax-M2.7-highspeed",
        contextWindow: 204800,
        maxTokens: 192000,
        reasoning: false,
        input: ["text"],
      },
    ],
  },
};

/**
 * Look up a known provider by its ID (case-insensitive).
 */
export function getKnownProvider(providerId: string): KnownProviderMeta | null {
  const normalized = providerId.toLowerCase();
  return KNOWN_PROVIDERS[normalized] ?? null;
}

/**
 * Enrich a model entry with known metadata when fields are missing.
 */
export function enrichModelMeta(
  providerId: string,
  model: { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: string[] },
): typeof model {
  const knownProvider = getKnownProvider(providerId);
  if (!knownProvider) return model;

  const knownModel = knownProvider.models.find(
    (m) => m.id === model.id || m.id.toLowerCase() === model.id.toLowerCase(),
  );
  if (!knownModel) return model;

  return {
    ...model,
    name: model.name || knownModel.name,
    contextWindow: model.contextWindow ?? knownModel.contextWindow,
    maxTokens: model.maxTokens ?? knownModel.maxTokens,
    reasoning: model.reasoning ?? knownModel.reasoning,
    input: model.input ?? knownModel.input,
  };
}
