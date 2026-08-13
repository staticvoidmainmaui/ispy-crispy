// config.mjs
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const supabaseUrl = process.env.SUPABASE_URL;
export const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;


export const DEV_USER = "00000000-0000-0000-0000-000000000001";

const PROVIDERS = {
  xenova:  { dims:  384, embed: embedXenova },
  titan:   { dims: 1024, embed: embedTitan  },
};

export const { dims } = PROVIDERS[EMBEDDING_PROVIDER]
export const getEmbedding = (text) => PROVIDERS[EMBEDDING_PROVIDER].embed(text);

