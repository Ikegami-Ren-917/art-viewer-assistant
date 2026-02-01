// app/api/chat/route.ts
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

// ====== デバッグログ用 ======
function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
function isoNow() {
  return new Date().toISOString();
}

// messages の中身を「要約だけ」ログに出す（本文やbase64は出さない）
function summarizeForLog(messages: any[]) {
  return (messages ?? []).map((m: any) => {
    const role = m?.role;
    const c = m?.content;

    if (typeof c === "string") {
      const snippet = c.slice(0, 120).replace(/\s+/g, " ");
      return { role, contentType: "string", length: c.length, snippet };
    }

    if (Array.isArray(c)) {
      const partTypes = c.map((p: any) => p?.type ?? typeof p);
      const hasImage =
        c.some((p: any) => p?.type === "image_url" || p?.type === "input_image") ||
        c.some((p: any) => p?.image_url?.url) ||
        c.some((p: any) => p?.input_image);

      const imageKind = c
        .filter((p: any) => p?.type === "image_url")
        .map((p: any) => {
          const url = p?.image_url?.url;
          if (typeof url !== "string") return "none";
          return url.startsWith("data:") ? "dataURL" : "url";
        });

      return { role, contentType: "array", parts: partTypes, hasImage, imageKind };
    }

    return { role, contentType: typeof c };
  });
}

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

function ensurePolicySystem(messages: ChatMessage[]) {
  const hasPolicy = messages.some((m) => m.role === "system" && m.content.includes("APP_POLICY_V2"));
  if (hasPolicy) return messages;
  return [{ role: "system" as const, content: APP_POLICY_V2 }, ...messages];
}

/**
 * 【案A】systemを2本固定（影響最小＆安定）
 * - policySystem: APP_POLICY_V2（必ず1本）
 * - stepSystem: APP_POLICY_V2以外のsystemの「最後の1本」を採用（あれば）
 * - 履歴窓化はsystem以外のみ（KEEP_TURNS*2）
 */
function enforceTwoSystemsAndWindow(messages: ChatMessage[]) {
  const systems = messages.filter((m) => m.role === "system");
  const others = messages.filter((m) => m.role !== "system");

  const policySystem =
    systems.find((s) => s.content.includes("APP_POLICY_V2")) ??
    ({ role: "system" as const, content: APP_POLICY_V2 });

  const stepSystems = systems.filter((s) => !s.content.includes("APP_POLICY_V2"));
  const stepSystem = stepSystems.length > 0 ? stepSystems[stepSystems.length - 1] : null;

  const tail = others.slice(Math.max(0, others.length - KEEP_TURNS * 2));

  const out: ChatMessage[] = [policySystem];
  if (stepSystem) out.push(stepSystem);
  out.push(...tail);
  return out;
}

// ====== 拒否文の検知（画像説明拒否 + 人物特定拒否 + 一般的な画像拒否） ======
function isRefusalLike(text: string) {
  if (!text) return false;

  // 典型：画像について詳しい説明できません系
  const imageRefusal =
    (/申し訳ありませんが/.test(text) &&
      /(画像|写真|この画像|その画像)/.test(text) &&
      /(具体的|詳しい|詳細|説明|情報|提供)/.test(text)) ||
    /(提供することはできません|お手伝いできません)/.test(text);

  // 典型：人物・個人特定できません系
  const personRefusal =
    /(人を特定|人物を特定|個人を特定|特定の人についてはコメントできません|顔認識|本人確認)/.test(text);

  return imageRefusal || personRefusal;
}

function dropRefusalAssistantHistory(msgs: ChatMessage[]) {
  return msgs.filter((m) => !(m.role === "assistant" && isRefusalLike(m.content)));
}

// ====== API ======
export async function POST(req: Request) {
  const debugId = crypto.randomUUID();

  console.log(`[chat:${debugId}] ${isoNow()} START`);
  console.log(`[chat:${debugId}] runtime=nodejs model=${MODEL}`);

  try {
    const form = await req.formData();
    const keys = Array.from(form.keys());
    console.log(`[chat:${debugId}] formData keys=${safeJson(keys)}`);

    const messagesJson = form.get("messages");
    const image = form.get("image");

    if (typeof messagesJson !== "string") {
      console.log(`[chat:${debugId}] ERROR missing messages`);
      return new Response("missing messages", { status: 400 });
    }

    // 画像ファイルの有無（base64化前にサイズとtypeだけログ）
    if (image && image instanceof File) {
      console.log(
        `[chat:${debugId}] image=YES name=${image.name} type=${image.type} size=${image.size}`
      );
    } else {
      console.log(`[chat:${debugId}] image=NO (${typeof image})`);
    }

    // 1) JSON -> ChatMessage[] に安全変換
    const parsed: unknown = JSON.parse(messagesJson);
    let messages: ChatMessage[] = toChatMessages(parsed);
    console.log(`[chat:${debugId}] messages parsed count=${messages.length}`);

    // 2) policy を必ず入れる
    messages = ensurePolicySystem(messages);

    // 3) system 2本固定 + 履歴窓化（system以外）
    const before = messages.length;
    messages = enforceTwoSystemsAndWindow(messages);
    console.log(
      `[chat:${debugId}] windowed before=${before} after=${messages.length} KEEP_TURNS=${KEEP_TURNS}`
    );

    // 3.5) 拒否系assistant履歴を落とす（連鎖防止）
    messages = dropRefusalAssistantHistory(messages);

    // 4) 画像をBase64データURLに変換（本文はログに出さない）
    let imageDataUrl: string | undefined;
    if (image && image instanceof File) {
      const arrayBuffer = await image.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      const mime = image.type || "image/jpeg";
      imageDataUrl = `data:${mime};base64,${base64}`;
      console.log(
        `[chat:${debugId}] imageDataUrl=READY mime=${mime} (base64Len=${base64.length})`
      );
    } else {
      console.log(`[chat:${debugId}] imageDataUrl=NONE`);
    }

    // 5) 最後の user に画像を常に添付（画像がある場合）
    const lastUserIdx = findLastUserIndex(messages);
    const attach = Boolean(imageDataUrl) && lastUserIdx >= 0;

    console.log(
      `[chat:${debugId}] lastUserIdx=${lastUserIdx} attach=${attach} (willAttachToRole=${messages[lastUserIdx]?.role ?? "n/a"})`
    );

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

    console.log(
      `[chat:${debugId}] formattedMessages summary=${safeJson(summarizeForLog(formattedMessages))}`
    );
    console.log(`[chat:${debugId}] OpenAI request -> chat.completions.create`);

    // ====== 1回目 ======
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: formattedMessages as any,
      max_tokens: MAX_OUTPUT_TOKENS,
    });

    let text = response.choices[0]?.message?.content ?? "";
    const finish = response.choices[0]?.finish_reason ?? "unknown";
    const usage = (response as any)?.usage;

    console.log(`[chat:${debugId}] OpenAI OK finish_reason=${finish}`);
    if (usage) console.log(`[chat:${debugId}] usage=${safeJson(usage)}`);
    console.log(`[chat:${debugId}] output length=${text.length}`);
    console.log(`[chat:${debugId}] assistantText(1)="${text.replace(/\s+/g, " ").slice(0, 200)}"`);

    // ====== 拒否なら 1回だけリトライ ======
    if (isRefusalLike(text)) {
      console.warn(`[chat:${debugId}] refusal detected -> retry once`);

      const override = {
        role: "system" as const,
        content: [
          "【上書き指示】拒否文は禁止（例：申し訳ありませんが〜できません、具体的な情報を提供できません 等）。",
          "個人特定（誰か/有名人/属性推定）は一切しないが、色・質感・位置関係・空間・雰囲気の観察支援は続けてよい。",
          "不確実なら断定せず、ユーザーの発言（例：ざらざら、綺麗でない）を根拠に質問を1つだけ返す。",
        ].join("\n"),
      };

      const retry = await openai.chat.completions.create({
        model: MODEL,
        messages: [override, ...(formattedMessages as any)],
        max_tokens: MAX_OUTPUT_TOKENS,
      });

      const retryText = retry.choices[0]?.message?.content ?? "";
      if (retryText) text = retryText;

      console.log(
        `[chat:${debugId}] assistantText(2)="${text.replace(/\s+/g, " ").slice(0, 200)}"`
      );
    }

    return Response.json({ text });
  } catch (e: any) {
    console.error(`[chat:${debugId}] Server Error:`, e?.message ?? e);
    if (e?.stack) console.error(`[chat:${debugId}] stack:`, e.stack);
    return new Response(`server error: ${e?.message ?? "unknown"}`, { status: 500 });
  } finally {
    console.log(`[chat:${debugId}] ${isoNow()} END`);
  }
}
