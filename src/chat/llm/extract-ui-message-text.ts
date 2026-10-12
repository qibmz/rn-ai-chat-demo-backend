export type UiMessageLike = {
  parts?: Array<{ type?: string; text?: string }>;
};

export function extractUiMessageText(
  message: UiMessageLike | null | undefined,
): {
  text: string;
  reasoningText: string | null;
} {
  const parts = message?.parts ?? [];
  let text = '';
  let reasoning = '';
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      reasoning += part.text;
    }
  }
  return { text, reasoningText: reasoning || null };
}
