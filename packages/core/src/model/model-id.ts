/**
 * Slug a string into a store-safe model id (letters, digits, hyphen).
 * Used by HuggingFace search (repo name) and migrate (GGUF filename).
 */
export function deriveModelId(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/\.gguf$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model"
  );
}
