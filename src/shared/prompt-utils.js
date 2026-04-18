export function compactJson(value) {
  return JSON.stringify(value, null, 2);
}

export function stripMarkdownFences(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export function parseJsonObject(text, fallback = null) {
  try {
    return JSON.parse(stripMarkdownFences(text));
  } catch {
    return fallback;
  }
}

export function asBulletList(items) {
  return items.filter(Boolean).map((item) => `- ${item}`).join("\n");
}
