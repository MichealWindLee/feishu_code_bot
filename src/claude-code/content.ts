import { isRecord } from "./utils.js";

export type ContentBlock = {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export function readContentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => isRecord(block));
}

export function stringifyContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (isRecord(block) && "text" in block) return String(block.text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}
