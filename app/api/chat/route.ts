import OpenAI from "openai";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Role = "system" | "user" | "assistant";
type ChatMessage = { role: Role; content: string };

// ====== 設定 ======
const MODEL = "gpt-4o";
const MAX_OUTPUT_TOKENS = 800;
const KEEP_TURNS = 10;

// 固定ルールは system で1回だけ
const APP_POLICY_V2 = [
  "## [APP_POLICY_V2]",
  "この画像は芸術作品（絵画）です。対話は『画面内の描写』だけを扱い、観察と言語化を支援してください。",
  "",
  "## [GUIDE ROLE]",
  "あなたは『知識を教える人』ではなく『観察を促すガイド』です。",
  "",
  "## [SAFETY & STYLE]",
  "- 個人名・作者名・作品名・主義名などの固有名詞は出しません。",
  "- 返答の冒頭に免責や注意書きを置かない（例：できません／特定できません／分かりません などで始めない）。",
  "",
  "## [OUTPUT]",
  "- JSON指定がない限り、自然文で簡潔に返答する。",
].join("\n");

// ====== 型ガード ======
function isRole(x: unknown): x is Role {
  return x === "system" || x === "user" || x === "assistant";
}

function toChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      "role" in item &&
      "content" in item &&
      isRole((item as any).role) &&
      typeof (item as any).content === "string"
    ) {
      out.push({ role: (item as any).role, content: (item as any).content });
    }
  }
  return out;
}

// ====== ユーティリティ ======
function findLastUserIndex(msgs: ChatMessage[]) {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") return i;
  return -1;
}

function windowMessages(messages: ChatMessage[]) {
  const systems = messages.filter((m) => m.role === "system");
  const others = messages.filter((m) => m.role !== "system");
  const tail = others.slice(Math.max(0, others.length - KEEP_TURNS * 2));
  return [...systems, ...tail];
}

function ensurePolicySystem(messages: ChatMessage[]) {
  const hasPolicy = messages.some((m) => m.role === "system" && m.content.includes("APP_POLICY_V2"));
  if (hasPolicy) return messages;
  return [{ role: "system" as const, content: APP_POLICY_V2 }, ...messages];
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const messagesJson = form.get("messages");
    const image = form.get("image");

    if (typeof messagesJson !== "string") {
      return new Response("missing messages", { status: 400 });
    }

    // 1) JSON -> ChatMessage[] に安全変換
    const parsed: unknown = JSON.parse(messagesJson);
    let messages: ChatMessage[] = toChatMessages(parsed);

    // 2) system固定ルールを先頭に1回だけ追加
    messages = ensurePolicySystem(messages);

    // 3) 履歴を窓化
    messages = windowMessages(messages);

    // 4) 画像をBase64データURLに変換
    let imageDataUrl: string | undefined;
    if (image && image instanceof File) {
      const arrayBuffer = await image.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      const mime = image.type || "image/jpeg";
      imageDataUrl = `data:${mime};base64,${base64}`;
    }

    // 5) 最後の user に画像を常に添付（画像がある場合）
    const lastUserIdx = findLastUserIndex(messages);
    const attach = Boolean(imageDataUrl) && lastUserIdx >= 0;

    const formattedMessages = messages.map((m, idx) => {
      if (attach && idx === lastUserIdx && m.role === "user" && imageDataUrl) {
        return {
          role: "user" as const,
          content: [
            { type: "text" as const, text: m.content },
            { type: "image_url" as const, image_url: { url: imageDataUrl } },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: formattedMessages as any,
      max_tokens: MAX_OUTPUT_TOKENS,
    });

    const text = response.choices[0]?.message?.content ?? "";
    return Response.json({ text });
  } catch (e: any) {
    console.error("Server Error:", e);
    return new Response(`server error: ${e?.message ?? "unknown"}`, { status: 500 });
  }
}
