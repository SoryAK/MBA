import { fail, serviceGet } from "./client.js";

/**
 * Resolve a model reference to an absolute GGUF path. An absolute path is
 * used verbatim; otherwise it is treated as a model id and resolved via
 * GET /models (the service is the source of truth for the file path).
 */
export async function resolveModelFile(baseUrl: string, ref: string): Promise<string> {
  if (ref.startsWith("/") && ref.endsWith(".gguf")) return ref;
  const { models } = await serviceGet<{ models: { id: string; modelFile?: string }[] }>(
    baseUrl,
    "/models",
  );
  const match = models.find((m) => m.id === ref);
  if (!match || !match.modelFile) {
    fail(`unknown model '${ref}' — see 'mba models list' for known ids`);
  }
  return match.modelFile;
}
