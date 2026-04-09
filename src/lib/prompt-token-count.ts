import { countTokens } from "gpt-tokenizer/model/gpt-4o";

export function countOrchestrationPromptTokens(text: string): number {
  return countTokens(text);
}
