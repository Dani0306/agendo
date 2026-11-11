// The only place model IDs live. OpenAI is the only model provider.
// IDs and prices read from OpenAI's pricing page, 2026-11-08.

export const PRIMARY_MODEL = "gpt-6-luna";

/** A candidate only: open decision 2 picks the real fallback from measured numbers. */
export const FALLBACK_MODEL_CANDIDATE = "gpt-6.1-sol";
