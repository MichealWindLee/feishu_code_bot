import type { AgentUserInputRequest, AgentUserInputResponse } from "../agent/types.js";

const MAX_OPTIONS_PER_QUESTION = 4;
const LARGE_OPTION_THRESHOLD = 4;

export function renderUserInputCard(
  request: AgentUserInputRequest,
  userInputId: string,
  response: AgentUserInputResponse = { answers: {} },
): object {
  const elements: object[] = [
    {
      tag: "div",
      text: { tag: "lark_md", content: request.body || "请补充信息，以便继续处理。" },
    },
  ];

  request.questions.forEach((question, questionIndex) => {
    const selected = response.answers[question.question];
    const selectedLabels = Array.isArray(selected) ? selected : selected ? [selected] : [];
    const selectedText = selectedLabels.length > 0 ? `\n已选择：${selectedLabels.join(", ")}` : "";
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: [`**${question.header || `Question ${questionIndex + 1}`}**`, question.question, selectedText].join("\n"),
      },
    });

    if (!question.multiSelect && question.options.length > LARGE_OPTION_THRESHOLD) {
      elements.push({
        tag: "action",
        actions: [renderSelect(question.options, selectedLabels[0], userInputId, questionIndex)],
      });
    } else {
      for (const optionGroup of chunk(question.options, MAX_OPTIONS_PER_QUESTION)) {
        elements.push({
          tag: "action",
          actions: optionGroup.map((option) => ({
            tag: "button",
            text: { tag: "plain_text", content: truncate(option.label, 20) },
            type: selectedLabels.includes(option.label) ? "primary" : "default",
            value: {
              action: "answer_user_input",
              userInputId,
              questionIndex,
              answer: option.label,
            },
          })),
        });
      }
    }

    const descriptions = question.options
      .map((option) => `- **${option.label}**: ${option.description}`)
      .join("\n");
    if (descriptions) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: truncate(descriptions, 720) },
      });
    }
    if (question.multiSelect) {
      elements.push({
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "提交选择" },
            type: "primary",
            value: {
              action: "submit_user_input",
              userInputId,
              questionIndex,
            },
          },
        ],
      });
    }
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: request.title },
    },
    elements,
  };
}

function renderSelect(
  options: AgentUserInputRequest["questions"][number]["options"],
  selectedLabel: string | undefined,
  userInputId: string,
  questionIndex: number,
): object {
  const select: Record<string, unknown> = {
    tag: "select_static",
    type: "default",
    placeholder: { tag: "plain_text", content: "请选择一个选项" },
    options: options.map((option) => ({
      text: { tag: "plain_text", content: truncate(option.label, 40) },
      value: option.label,
    })),
    value: {
      action: "answer_user_input",
      userInputId,
      questionIndex,
    },
  };
  if (selectedLabel) select.initial_option = selectedLabel;
  return select;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}
