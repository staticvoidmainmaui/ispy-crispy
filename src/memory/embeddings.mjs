// Stage 3 — the embedding provider seam.
// One getEmbedding(), model chosen by config. Replaces the copies in
// writeMemory.mjs:17 and recall.mjs:19.

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

// ── Config ───────────────────────────────────────────────────────────────────
const PROVIDER = process.env.EMBEDDING_PROVIDER ?? "titan";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const TITAN_MODEL_ID = "amazon.titan-embed-text-v2:0";
const TITAN_DIMS = 1024;

// ── Xenova / all-MiniLM-L6-v2 ────────────────────────────────────────────────
let embedder;

async function embedXenova(text) {
  //lazy import
  const { pipeline } = await import("@xenova/transformers");
  if (!embedder) {
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

// ── Bedrock Titan Text Embeddings V2 ─────────────────────────────────────────
const client = new BedrockRuntimeClient({ region: AWS_REGION });

async function embedTitan(text) {
  const input = {
      modelId: TITAN_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text,
        dimensions: TITAN_DIMS,
        normalize: true,
      }),
    };
  const command = new InvokeModelCommand(input)
  const response = await client.send(command);

  const { embedding } = JSON.parse(new TextDecoder().decode(response.body));
  return embedding;
}

// ── Provider seam ────────────────────────────────────────────────────────────
const PROVIDERS = {
  xenova: { dims: 384, embed: embedXenova },
  titan: { dims: TITAN_DIMS, embed: embedTitan },
};

const selected = PROVIDERS[PROVIDER];

if (!selected) {
  throw new Error(
    `Unknown EMBEDDING_PROVIDER "${PROVIDER}". Expected one of: ${Object.keys(PROVIDERS).join(", ")}`,
  );
}

export const dims = selected.dims;

// ── Public API ───────────────────────────────────────────────────────────────
export async function getEmbedding(text) {
  const vector = await selected.embed(text);

  //dimension-matching
  if (vector.length !== dims) {
    throw new Error(
      `getEmbedding(): ${PROVIDER} returned ${vector.length} dimensions, expected ${dims}.`,
    );
  }

  return vector;
}
