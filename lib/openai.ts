import OpenAI from "openai";

export function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY가 설정되지 않았습니다. .env.local을 확인하세요.");
  }
  return new OpenAI({ apiKey });
}

export async function createStructuredResponse<T>({
  model,
  instructions,
  input,
  schemaName,
  schema,
  reasoningEffort = "low",
  maxOutputTokens,
}: {
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  maxOutputTokens?: number;
}): Promise<T> {
  const client = getOpenAI();
  const response = await client.responses.create({
    model,
    instructions,
    input,
    reasoning: { effort: reasoningEffort },
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema,
      },
    },
  });

  if (!response.output_text) {
    throw new Error("OpenAI 응답에 output_text가 없습니다.");
  }

  return JSON.parse(response.output_text) as T;
}
