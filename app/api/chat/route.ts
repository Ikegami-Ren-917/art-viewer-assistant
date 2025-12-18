// app/api/chat/route.ts
import OpenAI from "openai";

export const runtime = "nodejs";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function pickInstructions(messages: ChatMessage[]) {
  // 先頭に system があれば instructions に退避
  const sys = messages.find((m) => m.role === "system")?.content;
  return sys ?? undefined;
}

function stripSystem(messages: ChatMessage[]) {
  return messages.filter((m) => m.role !== "system");
}

function findLastUserIndex(messages: Array<{ role: "user" | "assistant"; content: string }>) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return -1;
}

function toResponsesInput(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  imageDataUrl?: string
) {
  const lastUserIdx = findLastUserIndex(messages);

  return messages.map((m, idx) => {
    const content: any[] = [
      m.role === "assistant"
        ? { type: "output_text", text: m.content } // ✅ assistant は output_text
        : { type: "input_text", text: m.content }, // ✅ user は input_text
    ];

    // ✅ 画像は最後の user のみに付与
    if (imageDataUrl && idx === lastUserIdx && m.role === "user") {
      content.push({ type: "input_image", image_url: imageDataUrl });
    }

    return {
      type: "message",
      role: m.role,
      content,
    };
  });
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    const messagesJson = form.get("messages");
    const image = form.get("image");

    if (typeof messagesJson !== "string") {
      return new Response("missing messages", { status: 400 });
    }

    let messages: ChatMessage[];
    try {
      messages = JSON.parse(messagesJson) as ChatMessage[];
      if (!Array.isArray(messages)) throw new Error("messages must be an array");
    } catch {
      return new Response("invalid messages json", { status: 400 });
    }

    const instructions = pickInstructions(messages);
    const noSystem = stripSystem(messages).map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content ?? "",
    }));

    let imageDataUrl: string | undefined;
    if (image && image instanceof File) {
      const arrayBuffer = await image.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      const mime = image.type || "image/jpeg";
      imageDataUrl = `data:${mime};base64,${base64}`;
    }

    const input = toResponsesInput(noSystem, imageDataUrl);

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      ...(instructions ? { instructions } : {}),
      input: input as any, // ✅ SDK型の揺れ回避（安定）
    });

    return Response.json({ text: resp.output_text ?? "" });
  } catch (e: any) {
    return new Response(`server error: ${e?.message ?? "unknown"}`, { status: 500 });
  }
}
