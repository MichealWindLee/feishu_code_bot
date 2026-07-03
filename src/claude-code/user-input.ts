import type { AgentUserInputQuestion } from "../agent/types.js";
import { asRecord } from "./utils.js";

export function readQuestions(input: Record<string, unknown>): AgentUserInputQuestion[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions = rawQuestions
    .map((question): AgentUserInputQuestion | null => {
      const record = asRecord(question);
      const options = Array.isArray(record.options)
        ? record.options.flatMap((option) => {
          const optionRecord = asRecord(option);
          if (typeof optionRecord.label !== "string") return [];
          return [{
            label: optionRecord.label,
            description: typeof optionRecord.description === "string" ? optionRecord.description : "",
            preview: typeof optionRecord.preview === "string" ? optionRecord.preview : undefined,
          }];
        })
        : [];
      if (typeof record.question !== "string" || options.length === 0) return null;
      return {
        question: record.question,
        header: typeof record.header === "string" ? record.header : "Question",
        options,
        multiSelect: Boolean(record.multiSelect),
      };
    })
    .filter((question): question is AgentUserInputQuestion => question !== null);
  return questions.length > 0
    ? questions
    : [{
      question: "Claude Code needs input. How should it continue?",
      header: "Input",
      options: [
        { label: "Continue", description: "Let Claude Code continue with its best judgment." },
        { label: "Stop", description: "Ask Claude Code to stop this path." },
      ],
      multiSelect: false,
    }];
}
