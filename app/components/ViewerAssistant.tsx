"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  Wand2,
  Lightbulb,
  Image as ImageIcon,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  History as HistoryIcon,
  Trash2,
  CornerUpLeft,
  X,
} from "lucide-react";

/* ====== 型定義 ====== */
type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  hidden?: boolean;
};
type SendChatArgs = { messages: ChatMessage[]; imageFile?: File | null };
type SendChatFn = (args: SendChatArgs) => Promise<string>;
type Step3Candidate = { label: string; element: string; location: string; evidence: string };

// Step2の具象物カード用の型
type S2ObjectCard = {
  label: string;
  completed: boolean;
};

// 記録した視点(常に残す一覧用)
type SavedView = Step3Candidate & {
  savedAt: number;
  summary?: string;
};

// セッション(履歴)用
type Session = {
  id: string;
  createdAt: number;
  updatedAt: number;

  // 画像はサムネのみIndexedDBへ保存
  hasThumb: boolean;

  impression: string;
  objects: string;

  s2Summary: string;
  s2Dialogs: Record<string, ChatMessage[]>;

  s3Summary: string;
  s3SavedViews: SavedView[];
  s3Dialogs: Record<string, ChatMessage[]>;

  finalResult: string;
  editedFinalResult: string;
};

const MAX_SESSIONS = 20;
const LS_KEY = "viewer_assistant_sessions_v1";
const IDB_NAME = "viewer_assistant_db";
const IDB_STORE = "session_thumbs";

/*
 * ====== step番号の対応表 ======
 * step === 1 : Step 1: 観察（初期入力画面）
 * step === 2 : Step 2: 深掘り（具象物の対話）
 * step === 3 : Step 3: 新しい視点（別視点候補と対話）
 * step === 4 : 最終解釈（鑑賞文の生成・編集・履歴参照）
 *
 * loading の値も同じ番号で対応：
 *   loading === 2 → Step 2のAPI通信中
 *   loading === 3 → Step 3のAPI通信中
 *   loading === 4 → 最終解釈のAPI通信中
 */

/* ====== 表示用：モデル返答の整形（JSONやコードフェンスを見せない） ====== */
function normalizeAssistantText(raw: string): string {
  const t = (raw || "").trim();

  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const inside = fenceMatch ? fenceMatch[1].trim() : t;

  const tryParse = (s: string): string | null => {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;
    try {
      const obj = JSON.parse(s.slice(first, last + 1));
      const q = obj?.question;
      if (typeof q === "string" && q.trim()) return q.trim();
      return null;
    } catch {
      return null;
    }
  };

  const parsed = tryParse(inside) || tryParse(t);
  if (parsed) return parsed;

  const q2 = inside.match(/"question"\s*:\s*"([^"]+)"/);
  if (q2?.[1]) return q2[1].trim();

  return inside.replace(/```/g, "").trim();
}

function normalizeObjectsForPrompt(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return s;

  const sep = "[\\s、，,。\\.\\n\\r\\t]";
  let out = s.replace(/人物/g, "人");
  out = out.replace(new RegExp(`(^|${sep})人(?=$|${sep})`, "g"), `$1人`);
  out = out.replace(/(この)?人物は誰(ですか)?/g, "人はどんな見え方ですか");

  return out;
}

/* ====== 具象物の分割（カンマ、読点などで分割） ====== */
function splitObjects(raw: string): string[] {
  return raw
    .split(/[、，,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* ====== API連携関数（hiddenは送らない） ====== */
async function defaultSendChat({ messages, imageFile }: SendChatArgs): Promise<string> {
  const fd = new FormData();
  const payload = messages.map(({ role, content }) => ({ role, content }));
  fd.append("messages", JSON.stringify(payload));
  if (imageFile) fd.append("image", imageFile);

  const res = await fetch("/api/chat", { method: "POST", body: fd });
  if (!res.ok) throw new Error("API error");
  const data = await res.json();
  return data.text;
}

/* ====== Step2 プロンプト（意味づけを強制＆JSON禁止） ====== */
function buildStep2SystemPrompt() {
  return [
    "【重要：画像認識に関する命令】",
    "あなたは対話型鑑賞のガイドです。目的はユーザーの観察と言語化を支援することです。",
    "",
    "【厳守事項】",
    "1. ユーザーが挙げた物以外には一切触れないでください（新しい物の提示禁止）。",
    "2. 状態を形容する言葉（溶けている、歪んでいる等）をAIから先に使わないでください（ユーザーが言った語は引用として使用可）。",
    "3. ユーザーが入力した物すべてに対して、1つずつ丁寧に抜けなく問いかけを行ってください。",
    "",
    "【問いかけの設計：観点（レンズ）の提示】",
    "- 【形の観点】輪郭や形に注目したとき、何か気づくことはありますか？",
    "- 【質感の観点】表面の様子や重みから、どのような感触が伝わってきそうですか？",
    "- 【空間の観点】置かれている場所や周囲の\"空間\"との関わり（距離・余白・位置）に特徴はありますか？",
    "",
    "【出力形式（ここが重要）】",
    "毎ターン、必ず次の3部構成で日本語の自然文で返してください。JSONやコードブロックは禁止。",
    "ユーザーの観察を短く言い換えて認める（1文）",
    "その観察が印象（感情/雰囲気）にどう関係しうるかを問いかけ",
    "次の一歩になる問いかけを1つだけ（1文、同じ聞き方の繰り返し禁止）",
  ].join("\n");
}

/* ====== Step2 kickoff（内部指示は hidden にしてUIへ出さない） ====== */
function buildStep2KickoffForObject(imp: string, obj: string): ChatMessage[] {
  return [
    { role: "system", content: buildStep2SystemPrompt(), hidden: true },
    {
      role: "user",
      hidden: true,
      content: `印象：${imp}\n現在深掘り中の物：${obj}\n\nこの物について、「形/質感/空間」のどれか1つの観点で質問を1つしてください。`,
    },
  ];
}

/* ====== Step2要約（対話ログから生成） ====== */
function buildStep2SummarizeMessages(s2Msgs: ChatMessage[]): ChatMessage[] {
  const transcript = s2Msgs
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  return [
    {
      role: "system",
      content:
        "あなたは要約者です。以下の対話を要約してください。\n\n【形式】\n各物体ごとに、ユーザーがどう観察したかを簡潔にまとめる。\n例：\n・人：不安そうに見える、背景から浮いている\n・オレンジ：溶けているような質感、明るい色\n\n余計な前置きや説明は不要です。",
    },
    { role: "user", content: transcript || "（対話ログなし）" },
  ];
}

/* ====== Step3候補：JSON安全パース ====== */
function safeParseCandidates(text: string): Step3Candidate[] | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  try {
    const json = JSON.parse(text.slice(first, last + 1));
    const cands = json?.candidates;
    if (!Array.isArray(cands)) return null;

    const normalized = cands
      .map((c: any) => ({
        label: String(c?.label ?? "").trim().replace(/人物/g, "人影").replace(/^人$/, "人影"),
        element: String(c?.element ?? "").trim(),
        location: String(c?.location ?? "").trim(),
        evidence: String(c?.evidence ?? "").trim(),
      }))
      .filter((c: Step3Candidate) => c.label && c.element && c.location && c.evidence);

    return normalized.length ? normalized : null;
  } catch {
    return null;
  }
}

/* ====== Step3候補生成（画像あり, 記録済み視点も渡して意味重複を減らす） ====== */
function buildStep3CandidateMessages(
  step1Objects: string,
  step2Summary: string,
  excludedLabels: string[],
  recordedViews: SavedView[]
): ChatMessage[] {
  const excludedSection =
    excludedLabels.length > 0
      ? `\n\n[既に提示した候補（再提示禁止）]\n${excludedLabels.map((l) => `- ${l}`).join("\n")}`
      : "";

  const recordedSection =
    recordedViews.length > 0
      ? `\n\n[記録済みの視点（意味が近い候補も再提示禁止）]\n${recordedViews
          .map(
            (v) =>
              `- ${v.label} / ${v.location} / ${v.element} / 根拠:${v.evidence}${v.summary ? ` / 要約:${v.summary}` : ""}`
          )
          .join("\n")}`
      : "";

  return [
    {
      role: "system",
      content: [
        "あなたは画像解析の専門家です。",
        "必ずJSONだけを返してください（説明文、前置き、コードフェンスは禁止）。",
        '出力スキーマ: {"candidates":[{"label":string,"element":string,"location":string,"evidence":string}]}',
        "",
        "【タスクの目的】",
        "添付された画像を見て、実際に映っている具象物を検出してください。",
        "その中からStep1/Step2で触れていない具象物を列挙してください。",
        "",
        "【検出の優先度】",
        "- 画像の中で明確に見える物体を優先してください。",
        "- 背景や周辺にある小さな物体も含めて、できるだけ多く検出してください。",
        "- 曖昧でも形が分かる物体は含めてください。",
        "",
        "【重複判定ルール（厳格）】",
        "以下は同一物体とみなして除外:",
        "- 「人」「人物」「人影」「人の姿」はすべて同一とみなす",
        "- 「木」「樹木」「植物」はすべて同一とみなす",
        "- 類似した表現（例：「空」と「青空」、「建物」と「家」、「机」と「テーブル」）は同一とみなす",
        "",
        "【意味の重複も禁止（重要）】",
        "記録済みの視点と, 実質的に同じ意味・役割の候補は出さないでください。",
        "たとえば, 記録済みが『窓』なら『ガラス窓』『窓枠』『外の景色』のような実質同じ焦点は避ける, など。",
        "",
        "【制約】",
        "1) label は物体名（例：時計、鳥、机、壁、床、窓、椅子、本、カーテンなど）。",
        "2) element は画像で実際に観察できる特徴を書く（断定せず「〜と思われる」等の表現可）。",
        "3) location は画像内での位置（背景、手前、中央、左側、右側、上部、下部など）。",
        "4) evidence は画像内でその物体が見える根拠を書く（何を見て判断したかを具体的に）。",
        "5) 既に言及された物体と重複・類似する場合は含めない。",
        "6) 候補は3つ以上, 可能な限り多く検出してください。",
        "7) 人が映っていても label は『人影/人の姿』のように非同定の表現にする（人物特定や属性推定は禁止）。",
        "8) 画家名/作品名/主義名など固有名詞は禁止。",
      ].join("\n"),
    },
    {
      role: "user",
      content: `[ユーザーがStep1で言及した物]
${step1Objects}

[Step2での対話要約（どんな物についてどう語られたか）]
${step2Summary || "（要約なし）"}${excludedSection}${recordedSection}

[出力]
画像を見て, 上記で触れられていない『具象物』を検出して candidates に列挙してJSONで返してください。
できるだけ多く検出してください。`,
    },
  ];
}

/* ====== Step3対話（選んだ具象物でStep2同型の意味づけ対話） ====== */
function buildStep3SystemPromptForObject() {
  return [
    "あなたは対話型鑑賞のガイドです。ユーザーが選んだ『具象物』について、Step2と同じ形式で深掘りし、意味づけを支援してください。",
    "",
    "【厳守事項】",
    "1. 今回扱う対象はユーザーが選んだ『その具象物』のみ。新しい物体の提示は禁止。",
    "2. 状態を形容する言葉（溶けている、歪んでいる等）をAIから先に使わない（ユーザーが言った語は引用として使用可）。",
    "3. 物語を断定して教えない。ユーザーの言葉を引き出す。",
    "【人物に関する特別ルール（重要）】",
    "- 対象が人物/人影であっても、誰かの特定・属性推定（性別/年齢/国籍/職業/有名人か等）は一切しない。",
    "- その代わり『人影』『人の姿』として、形/質感/空間（位置・距離・背景との関係）だけを扱う。",
    "- 『申し訳ありませんが、人を特定できません』のような断り文は書かず、観察の問いを続ける。",
    "【最重要：拒否文禁止】",
    "「申し訳ありませんが〜できません」「具体的な情報を提供できません」等の拒否文は一切出さない。",
    "画像に人物が含まれる可能性があっても、個人特定（誰か/有名人/属性推定）は一切しないが、色・質感・構図・位置関係・雰囲気の議論は継続してよい。",
    "もし確信が持てない場合は断定せず、「ユーザーの発言（例：ざらざら、綺麗でない）」を根拠に質問を1つだけ返す。",
    "",
    "【問いかけの観点】",
    "- 形（輪郭/形のまとまり/反復）",
    "- 質感（表面/重さ/素材感）",
    "- 空間（位置/距離/余白/周囲との配置関係）",
    "",
    "【出力形式】",
    "毎ターン、必ず次の3部構成で日本語の自然文で返す。JSONやコードブロックは禁止。",
    "1) ユーザーの観察を短く言い換えて認める（1文）",
    "2) その観察が印象（感情/雰囲気）にどう関係しうるかを問いかけ（1文）",
    "3) 次の一歩になる問いかけを1つだけ（1文、同じ聞き方の繰り返し禁止）",
  ].join("\n");
}

function buildStep3ChatKickoff(impression: string, step2Sum: string, cand: Step3Candidate): ChatMessage[] {
  return [
    { role: "system", content: buildStep3SystemPromptForObject(), hidden: true },
    {
      role: "user",
      hidden: true,
      content: `全体の印象：${impression}
Step2の要約：${step2Sum || "（要約なし）"}

選んだ具象物：${cand.label}
推測される特徴：${cand.element}
位置：${cand.location}
根拠：${cand.evidence}

この具象物について、まず「形/質感/空間」のいずれか1つの観点を選んで、次の一歩になる問いかけを1つ投げかけてください。`,
    },
  ];
}

function buildFinalMessages(s1I: string, s1O: string, s2S: string, s3S: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: "ユーザーの思考を整理するエディターとして、ユーザー自身の発見を称える主体的な鑑賞文を作成してください。",
    },
    {
      role: "user",
      content: `直感：${s1I}\n観察：${s1O}\n意味：${s2S}\n拡張：${s3S}\n\nこれらを統合して、一つの物語のような解釈にまとめてください。`,
    },
  ];
}

/* ====== Step3要約(記録済み視点一覧)の生成 ====== */
function buildStep3SummarizeFromSavedViewsMessages(savedViews: SavedView[]): ChatMessage[] {
  const lines =
    savedViews.length > 0
      ? savedViews
          .slice()
          .sort((a, b) => b.savedAt - a.savedAt)
          .map((v) => {
            const sum = (v.summary || "").trim();
            return [
              `- 対象: ${v.label}`,
              `  位置: ${v.location}`,
              `  特徴: ${v.element}`,
              `  根拠: ${v.evidence}`,
              sum ? `  要約: ${sum}` : `  要約: （未記録）`,
            ].join("\n");
          })
          .join("\n\n")
      : "（記録済み視点なし）";

  return [
    {
      role: "system",
      content: [
        "あなたは要約者です。",
        "以下はStep3でユーザーが『記録した視点』の一覧です。",
        "これらを, 最終解釈に使える形で簡潔にまとめてください。",
        "",
        "【形式】",
        "- 箇条書きで, 『対象 → ユーザーが言った観察/気づき(要約)』を列挙する。",
        "- 記録が無い対象は出さなくてよい。",
        "- 余計な前置き, 解説, 新しい解釈の付け足しは禁止。",
      ].join("\n"),
    },
    { role: "user", content: lines },
  ];
}

/* ====== Step2要約を, その瞬間のログから必ず作る ====== */
async function summarizeStep2Now(
  sendChat: SendChatFn,
  s2Dialogs: Record<string, ChatMessage[]>
): Promise<string> {
  const all: ChatMessage[] = [];
  Object.values(s2Dialogs).forEach((msgs) => all.push(...msgs));

  if (all.length === 0) return "";

  const sum = await sendChat({
    messages: buildStep2SummarizeMessages(all),
    imageFile: null,
  });
  return String(sum || "").trim();
}

/* ====== Step3要約を, 記録済み視点一覧から必ず作る ====== */
async function summarizeStep3Now(sendChat: SendChatFn, s3SavedViews: SavedView[]): Promise<string> {
  const recorded = (s3SavedViews || []).filter((v) => (v.summary || "").trim().length > 0);

  if (recorded.length === 0) return "";

  const sum = await sendChat({
    messages: buildStep3SummarizeFromSavedViewsMessages(recorded),
    imageFile: null,
  });
  return String(sum || "").trim();
}

/* ====== IndexedDB: open, put/get, delete ====== */
function openThumbDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dataUrlToFile(dataUrl: string, filename = "restored.jpg"): File | null {
  try {
    const [header, base64] = dataUrl.split(",");
    if (!header || !base64) return null;

    const mimeMatch = header.match(/data:(.*?);base64/);
    const mime = mimeMatch?.[1] || "image/jpeg";

    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

    const blob = new Blob([bytes], { type: mime });
    return new File([blob], filename, { type: mime });
  } catch {
    return null;
  }
}

async function idbPutThumb(sessionId: string, dataUrl: string): Promise<void> {
  const db = await openThumbDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(dataUrl, sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGetThumb(sessionId: string): Promise<string | null> {
  const db = await openThumbDB();
  const out = await new Promise<string | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(sessionId);
    req.onsuccess = () => resolve((req.result as string) || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

async function idbDeleteThumb(sessionId: string): Promise<void> {
  const db = await openThumbDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/* ====== 画像サムネ生成(File -> dataURL) ====== */
async function fileToThumbDataUrl(file: File, maxW = 320): Promise<string> {
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = blobUrl;
    });

    const scale = Math.min(1, maxW / Math.max(1, img.width));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/* ====== localStorage: load/save sessions ====== */
function loadSessionsFromLocalStorage(): Session[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((s: any) => ({
        id: String(s.id || ""),
        createdAt: Number(s.createdAt || Date.now()),
        updatedAt: Number(s.updatedAt || Date.now()),
        hasThumb: !!s.hasThumb,
        impression: String(s.impression || ""),
        objects: String(s.objects || ""),
        s2Summary: String(s.s2Summary || ""),
        s2Dialogs: (s.s2Dialogs && typeof s.s2Dialogs === "object" ? s.s2Dialogs : {}) as Record<string, ChatMessage[]>,
        s3Summary: String(s.s3Summary || ""),
        s3SavedViews: Array.isArray(s.s3SavedViews) ? (s.s3SavedViews as SavedView[]) : [],
        s3Dialogs: (s.s3Dialogs && typeof s.s3Dialogs === "object" ? s.s3Dialogs : {}) as Record<string, ChatMessage[]>,
        finalResult: String(s.finalResult || ""),
        editedFinalResult: String(s.editedFinalResult || ""),
      }))
      .filter((s: Session) => s.id);
  } catch {
    return [];
  }
}

function saveSessionsToLocalStorage(sessions: Session[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(sessions));
  } catch {
    // ignore
  }
}

/* ====== メインコンポーネント ====== */
export default function ViewerAssistant({ sendChat = defaultSendChat }: { sendChat?: SendChatFn }) {
  const [file, setFile] = useState<File | null>(null);
  const [imageURL, setImageURL] = useState("");

  // step: 1=観察, 2=深掘り, 3=新しい視点, 4=最終解釈
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  // loading: falseまたはstepと同じ番号で「そのstepで読み込み中」を表す
  const [loading, setLoading] = useState<false | 2 | 3 | 4>(false);

  const [impression, setImpression] = useState("");
  const [objects, setObjects] = useState("");

  // Step2の状態管理
  const [s2Cards, setS2Cards] = useState<S2ObjectCard[]>([]);
  const [s2CurrentObject, setS2CurrentObject] = useState<string | null>(null);
  const [s2Dialogs, setS2Dialogs] = useState<Record<string, ChatMessage[]>>({});
  const [s2Input, setS2Input] = useState("");
  const [s2Summary, setS2Summary] = useState("");

  // Step3の状態管理
  const [s3Candidates, setS3Candidates] = useState<Step3Candidate[]>([]);
  const [s3Chosen, setS3Chosen] = useState<string | null>(null);
  const [s3Msgs, setS3Msgs] = useState<ChatMessage[]>([]);
  const [s3Input, setS3Input] = useState("");
  const [s3Summary, setS3Summary] = useState("");

  // Step3の対話履歴(候補labelごと)
  const [s3Dialogs, setS3Dialogs] = useState<Record<string, ChatMessage[]>>({});

  // Step3: 記録済み視点の一覧(再生成しても消えない)
  const [s3SavedViews, setS3SavedViews] = useState<SavedView[]>([]);

  // Step3: 記録中/通知
  const [savingS3, setSavingS3] = useState(false);
  const [s3Toast, setS3Toast] = useState<string | null>(null);

  // 最終結果
  const [finalResult, setFinalResult] = useState("");
  const [isEditingFinal, setIsEditingFinal] = useState(false);
  const [editedFinalResult, setEditedFinalResult] = useState("");

  // 対話履歴の表示制御
  const [showS2History, setShowS2History] = useState(false);
  const [showS3History, setShowS3History] = useState(false);
  const [selectedHistoryObject, setSelectedHistoryObject] = useState<string | null>(null);

  // Step3の再生成用：既に提示した候補のlabelを蓄積する
  const [s3ExcludedLabels, setS3ExcludedLabels] = useState<string[]>([]);

  // 履歴セッション
  const [sessions, setSessions] = useState<Session[]>([]);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // 復元して再開しているセッションID(これがある場合, 保存は上書き更新)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  // サムネキャッシュ
  const [thumbCache, setThumbCache] = useState<Record<string, string | null>>({});

  // UI通知
  const [globalToast, setGlobalToast] = useState<string | null>(null);

  // オートスクロール用ref
  const s2ChatBottom = useRef<HTMLDivElement>(null);
  const s3ChatBottom = useRef<HTMLDivElement>(null);

  // 初回: localStorageから履歴復元
  useEffect(() => {
    const loaded = loadSessionsFromLocalStorage();
    setSessions(loaded.slice(0, MAX_SESSIONS));
    if (loaded[0]?.id) setActiveSessionId(loaded[0].id);
  }, []);

  // 現在画像のObjectURL管理
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImageURL(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // オートスクロール：Step2チャット
  useEffect(() => {
    if (s2ChatBottom.current) {
      s2ChatBottom.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [s2Dialogs, s2CurrentObject]);

  // オートスクロール：Step3チャット
  useEffect(() => {
    if (s3ChatBottom.current) {
      s3ChatBottom.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [s3Msgs]);

  const setToast = (msg: string, ms = 2000) => {
    setGlobalToast(msg);
    window.setTimeout(() => setGlobalToast(null), ms);
  };

  // サムネロード(必要な時だけ)
  const ensureThumbLoaded = async (sessionId: string) => {
    if (thumbCache[sessionId] !== undefined) return;
    setThumbCache((p) => ({ ...p, [sessionId]: null }));
    try {
      const t = await idbGetThumb(sessionId);
      setThumbCache((p) => ({ ...p, [sessionId]: t }));
    } catch {
      setThumbCache((p) => ({ ...p, [sessionId]: null }));
    }
  };

  // sessionsが変わったら, 先頭だけ先読み
  useEffect(() => {
    const ids = sessions.slice(0, 10).map((s) => s.id);
    ids.forEach((id) => {
      void ensureThumbLoaded(id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  // Step1 -> Step2へ：具象物をカード化して次へ進む
  const startStep2 = async () => {
    if (loading) return;
    const objectList = splitObjects(normalizeObjectsForPrompt(objects));
    const cards: S2ObjectCard[] = objectList.map((obj) => ({ label: obj, completed: false }));
    setS2Cards(cards);
    setS2Dialogs({});
    setS3ExcludedLabels([]);
    setS3Dialogs({});
    setS3SavedViews([]);
    setSavingS3(false);
    setS3Toast(null);
    setStep(2);
  };

  // Step2で具象物を選択して対話開始（画像送信は初回のみ）
  const selectS2Object = async (obj: string) => {
    if (loading) return;
    setS2CurrentObject(obj);

    if (s2Dialogs[obj]) return;

    const kickoff = buildStep2KickoffForObject(impression, obj);
    setS2Dialogs({ ...s2Dialogs, [obj]: kickoff });
    setLoading(2);
    try {
      const isFirstObject = Object.keys(s2Dialogs).length === 0;
      const outRaw = await sendChat({
        messages: kickoff,
        imageFile: isFirstObject ? file : null,
      });
      const out = normalizeAssistantText(outRaw);
      setS2Dialogs({ ...s2Dialogs, [obj]: [...kickoff, { role: "assistant", content: out }] });
    } finally {
      setLoading(false);
    }
  };

  // Step2のチャット送信（画像なし）
  const sendS2Chat = async () => {
    if (loading || !s2CurrentObject) return;
    if (!s2Input.trim()) return;

    const currentMsgs = s2Dialogs[s2CurrentObject] || [];
    const next = [...currentMsgs, { role: "user", content: s2Input } as ChatMessage];
    setS2Dialogs({ ...s2Dialogs, [s2CurrentObject]: next });
    setS2Input("");
    setLoading(2);
    try {
      const outRaw = await sendChat({ messages: next, imageFile: null });
      const out = normalizeAssistantText(outRaw);
      setS2Dialogs({ ...s2Dialogs, [s2CurrentObject]: [...next, { role: "assistant", content: out }] });
    } finally {
      setLoading(false);
    }
  };

  // 現在の具象物の対話を完了マークする
  const completeCurrentObject = () => {
    if (!s2CurrentObject) return;
    setS2Cards(s2Cards.map((card) => (card.label === s2CurrentObject ? { ...card, completed: true } : card)));
    setS2CurrentObject(null);
  };

  // Step2全体の要約生成（画像なし）
  const finalizeStep2 = async () => {
    if (loading) return;
    setLoading(2);
    try {
      const allMessages: ChatMessage[] = [];
      Object.values(s2Dialogs).forEach((msgs) => allMessages.push(...msgs));
      const sum = await sendChat({ messages: buildStep2SummarizeMessages(allMessages), imageFile: null });
      setS2Summary(sum);
      setToast("✅ Step2の要約を作成しました");
    } finally {
      setLoading(false);
    }
  };

  // Step3候補生成（画像あり）
  const prepareStep3 = async (excludeOverride?: string[]) => {
    if (loading) return;

    const savedLabels = s3SavedViews.map((v) => v.label);
    const baseExcluded = excludeOverride ?? s3ExcludedLabels;
    const mergedExcluded = [...new Set([...baseExcluded, ...savedLabels])];

    setLoading(3);
    try {
      if (!file) {
        setToast("⚠️ 画像が未選択です");
        setLoading(false);
        return;
      }

      const out = await sendChat({
        messages: buildStep3CandidateMessages(objects || "（未入力）", s2Summary || "（要約なし）", mergedExcluded, s3SavedViews),
        imageFile: file,
      });

      const parsed = safeParseCandidates(out);

      if (parsed && parsed.length > 0) {
        setS3Candidates(parsed);
        setStep(3);
      } else {
        setS3Candidates([]);
        if (window.confirm("新しい視点の候補が見つかりませんでした。このまま最終解釈を生成しますか？")) {
          await generateFinal();
        } else {
          setStep(2);
        }
      }
    } catch (error) {
      console.error("Step3候補生成エラー:", error);
      if (window.confirm("別視点の候補生成に失敗しました。このまま最終解釈を生成しますか？")) {
        await generateFinal();
      } else {
        setStep(2);
      }
    } finally {
      setLoading(false);
    }
  };

  // Step3の候補を再生成する
  const regenerateStep3 = async () => {
    if (loading) return;

    const newExcluded = [...s3ExcludedLabels, ...s3Candidates.map((c) => c.label), ...s3SavedViews.map((v) => v.label)];
    const deduped = [...new Set(newExcluded)];
    setS3ExcludedLabels(deduped);
    setS3Candidates([]);
    setS3Chosen(null);
    setS3Msgs([]);
    await prepareStep3(deduped);
  };

  // Step3対話開始: 既存ログがあれば復元, なければ初回kickoff
  const startS3Chat = async (cand: Step3Candidate) => {
    if (loading) return;
    setS3Chosen(cand.label);

    const existing = s3Dialogs[cand.label];
    if (existing && existing.length > 0) {
      setS3Msgs(existing);
      return;
    }

    const kickoff = buildStep3ChatKickoff(impression, s2Summary, cand);
    setS3Msgs(kickoff);
    setS3Dialogs((prev) => ({ ...prev, [cand.label]: kickoff }));

    setLoading(3);
    try {
      const outRaw = await sendChat({ messages: kickoff, imageFile: null });
      const out = normalizeAssistantText(outRaw);
      const nextMsgs = [...kickoff, { role: "assistant", content: out } as ChatMessage];
      setS3Msgs(nextMsgs);
      setS3Dialogs((prev) => ({ ...prev, [cand.label]: nextMsgs }));
    } finally {
      setLoading(false);
    }
  };

  // 記録一覧から開く(候補が消えても開ける)
  const openSavedView = async (view: SavedView) => {
    if (loading) return;
    setS3Chosen(view.label);

    const existing = s3Dialogs[view.label];
    if (existing && existing.length > 0) {
      setS3Msgs(existing);
      return;
    }

    const kickoff = buildStep3ChatKickoff(impression, s2Summary, view);
    setS3Msgs(kickoff);
    setS3Dialogs((prev) => ({ ...prev, [view.label]: kickoff }));

    setLoading(3);
    try {
      const outRaw = await sendChat({ messages: kickoff, imageFile: null });
      const out = normalizeAssistantText(outRaw);
      const nextMsgs = [...kickoff, { role: "assistant", content: out } as ChatMessage];
      setS3Msgs(nextMsgs);
      setS3Dialogs((prev) => ({ ...prev, [view.label]: nextMsgs }));
    } finally {
      setLoading(false);
    }
  };

  // Step3チャット送信（画像なし）
  const sendS3Chat = async () => {
    if (loading) return;
    if (!s3Input.trim()) return;
    if (!s3Chosen) return;

    const next = [...s3Msgs, { role: "user", content: s3Input } as ChatMessage];
    setS3Msgs(next);
    setS3Dialogs((prev) => ({ ...prev, [s3Chosen]: next }));

    setS3Input("");
    setLoading(3);
    try {
      const outRaw = await sendChat({ messages: next, imageFile: null });
      const out = normalizeAssistantText(outRaw);

      const next2 = [...next, { role: "assistant", content: out } as ChatMessage];
      setS3Msgs(next2);
      setS3Dialogs((prev) => ({ ...prev, [s3Chosen]: next2 }));
    } finally {
      setLoading(false);
    }
  };

  // Step3の対話内容を要約して記録（記録中UI + 完了通知 + 記録一覧に残す）
  const recordS3Summary = async () => {
    if (savingS3 || loading) return;
    if (!s3Chosen) return;

    const candFromList = s3Candidates.find((c) => c.label === s3Chosen);
    const candFromSaved = s3SavedViews.find((v) => v.label === s3Chosen);
    const base: Step3Candidate | null = candFromList || candFromSaved || null;

    if (!base) {
      setS3Toast("⚠️ 記録対象が見つかりませんでした");
      setTimeout(() => setS3Toast(null), 2000);
      return;
    }

    setSavingS3(true);
    setS3Toast(null);
    try {
      const sum = await sendChat({ messages: buildStep2SummarizeMessages(s3Msgs), imageFile: null });
      setS3Summary(sum);

      setS3SavedViews((prev) => {
        const exists = prev.find((v) => v.label === base.label);
        if (exists) {
          return prev.map((v) => (v.label === base.label ? { ...v, ...base, summary: sum, savedAt: Date.now() } : v));
        }
        return [...prev, { ...base, summary: sum, savedAt: Date.now() }];
      });

      setS3Toast("✅ 記録しました");
    } catch {
      setS3Toast("⚠️ 記録に失敗しました, もう一度試してください");
    } finally {
      setSavingS3(false);
      setTimeout(() => setS3Toast(null), 2000);
    }
  };

  // 最終解釈生成（画像なし）, 直前に Step2/Step3要約を自動再生成してから作る
  const generateFinal = async () => {
    if (loading) return;
    setLoading(4);

    try {
      // 1) Step2要約を, その瞬間のログから作り直す
      const freshS2 = await summarizeStep2Now(sendChat, s2Dialogs);
      if (freshS2) setS2Summary(freshS2);

      // 2) Step3要約を, 記録済み視点から作り直す
      const freshS3 = await summarizeStep3Now(sendChat, s3SavedViews);
      if (freshS3) setS3Summary(freshS3);

      // 3) 最終解釈を生成, fresh を優先し, 無ければ既存を使う
      const out = await sendChat({
        messages: buildFinalMessages(
          impression,
          objects,
          freshS2 || s2Summary || "（Step2の要約は未記録）",
          freshS3 || s3Summary || "（Step3の視点は未記録）"
        ),
        imageFile: null,
      });

      setFinalResult(out);
      setEditedFinalResult(out);
      setStep(4);
    } finally {
      setLoading(false);
    }
  };

  // 現在の状態を履歴に保存(新規 or 上書き更新)
  const saveOrUpdateSession = async () => {
    const now = Date.now();
    const id = currentSessionId ?? crypto.randomUUID();

    const session: Session = {
      id,
      createdAt: currentSessionId ? sessions.find((s) => s.id === id)?.createdAt ?? now : now,
      updatedAt: now,
      hasThumb: !!file || !!(await idbGetThumb(id).catch(() => null)),
      impression,
      objects,
      s2Summary,
      s2Dialogs,
      s3Summary,
      s3SavedViews,
      s3Dialogs,
      finalResult,
      editedFinalResult,
    };

    // localStorage更新
    setSessions((prev) => {
      const exists = prev.some((s) => s.id === id);
      const next = exists ? prev.map((s) => (s.id === id ? session : s)) : [session, ...prev].slice(0, MAX_SESSIONS);

      saveSessionsToLocalStorage(next);
      return next;
    });
    setActiveSessionId(id);

    // サムネ更新(ファイルがあるときだけ上書き)
    if (file) {
      try {
        const thumb = await fileToThumbDataUrl(file, 320);
        if (thumb) {
          await idbPutThumb(id, thumb);
          setThumbCache((p) => ({ ...p, [id]: thumb }));
          // hasThumbを立て直す
          setSessions((prev) => {
            const next = prev.map((s) => (s.id === id ? { ...s, hasThumb: true, updatedAt: now } : s));
            saveSessionsToLocalStorage(next);
            return next;
          });
        }
      } catch {
        // ignore
      }
    }

    setCurrentSessionId(id);
  };

  const resetToStep1 = () => {
    setFile(null);
    setImageURL("");
    setStep(1);
    setLoading(false);

    setImpression("");
    setObjects("");

    setS2Cards([]);
    setS2CurrentObject(null);
    setS2Dialogs({});
    setS2Input("");
    setS2Summary("");

    setS3Candidates([]);
    setS3Chosen(null);
    setS3Msgs([]);
    setS3Input("");
    setS3Summary("");

    setS3Dialogs({});
    setS3SavedViews([]);
    setSavingS3(false);
    setS3Toast(null);

    setFinalResult("");
    setIsEditingFinal(false);
    setEditedFinalResult("");

    setShowS2History(false);
    setShowS3History(false);
    setSelectedHistoryObject(null);

    setS3ExcludedLabels([]);

    // 新しい作品は別セッション扱い
    setCurrentSessionId(null);
  };

  // セッション削除
  const deleteSession = async (sessionId: string) => {
    const ok = window.confirm("この履歴を削除しますか？");
    if (!ok) return;

    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId);
      saveSessionsToLocalStorage(next);
      return next;
    });

    setThumbCache((p) => {
      const n = { ...p };
      delete n[sessionId];
      return n;
    });

    try {
      await idbDeleteThumb(sessionId);
    } catch {
      // ignore
    }

    if (activeSessionId === sessionId) {
      const nextId = sessions.find((s) => s.id !== sessionId)?.id || null;
      setActiveSessionId(nextId);
    }
    if (currentSessionId === sessionId) {
      setCurrentSessionId(null);
    }
    setToast("🗑️ 削除しました");
  };

  // セッション復元して続きから再開(= currentSessionId をそのIDにする)
  const restoreSession = async (s: Session) => {
    const ok = window.confirm("このセッションを復元して続きから再開しますか？現在の作業は上書きされます。");
    if (!ok) return;

    let thumb: string | null = null;
    try {
      thumb = await idbGetThumb(s.id);
      setThumbCache((p) => ({ ...p, [s.id]: thumb }));
    } catch {
      thumb = null;
    }

    setCurrentSessionId(s.id);

    setImpression(s.impression || "");
    setObjects(s.objects || "");

    setS2Summary(s.s2Summary || "");
    setS2Dialogs(s.s2Dialogs || {});
    const objectList = splitObjects(normalizeObjectsForPrompt(s.objects || ""));
    setS2Cards(objectList.map((obj) => ({ label: obj, completed: false })));
    setS2CurrentObject(null);
    setS2Input("");

    setS3Summary(s.s3Summary || "");
    setS3SavedViews(s.s3SavedViews || []);
    setS3Dialogs(s.s3Dialogs || {});
    setS3Candidates([]);
    setS3Chosen(null);
    setS3Msgs([]);
    setS3Input("");
    setSavingS3(false);
    setS3Toast(null);
    setS3ExcludedLabels([]);

    setFinalResult(s.finalResult || "");
    setEditedFinalResult(s.editedFinalResult || s.finalResult || "");
    setIsEditingFinal(false);

    // 画像はサムネだけ復元
    // 画像: サムネがあれば File としても復元して Step3に使えるようにする
    if (thumb) {
      const restored = dataUrlToFile(thumb, `${s.id}.jpg`);
      if (restored) {
        setFile(restored);

        // 表示は objectURL にする(安定)
        const url = URL.createObjectURL(restored);
        setImageURL(url);
      } else {
        // 変換失敗時は表示だけ継続
        setFile(null);
        setImageURL(thumb);
      }

      setToast("✅ セッションを復元しました");
    } else {
      setFile(null);
      setImageURL("");
      setToast("⚠️ 画像が見つかりませんでした, 再アップロードしてください");
    }

    setStep(4);
    setShowHistoryPanel(false);
    setSelectedHistoryObject(null);
  };

  const activeSession = useMemo(() => sessions.find((x) => x.id === activeSessionId) || null, [sessions, activeSessionId]);

  return (
    <div className="w-full h-screen flex flex-col md:flex-row bg-background overflow-hidden relative">
      {/* 左上: 鑑賞履歴ボタン(目立つ位置に固定) */}
      <div className="absolute top-3 left-3 z-50">
        <Button variant="outline" size="sm" onClick={() => setShowHistoryPanel((v) => !v)} className="gap-2">
          <HistoryIcon className="h-4 w-4" />
          鑑賞履歴
        </Button>
      </div>

      {/* グローバル通知 */}
      {globalToast && (
        <div className="absolute top-3 right-3 z-50 text-xs px-3 py-2 rounded-lg bg-muted/70 border">
          {globalToast}
        </div>
      )}

      {/* 履歴パネル(画面左端に小さく固定表示) */}
      {showHistoryPanel && (
        <div className="absolute top-0 left-0 h-full w-[300px] bg-background border-r shadow-xl z-40 p-3 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold">鑑賞履歴</p>
            <Button variant="ghost" size="icon" onClick={() => setShowHistoryPanel(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {sessions.length === 0 ? (
            <div className="text-xs text-muted-foreground bg-muted/30 border rounded-lg p-3">まだ履歴はありません。</div>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => {
                const thumb = thumbCache[s.id];
                return (
                  <div
                    key={s.id}
                    className={`p-2 rounded-lg border ${activeSessionId === s.id ? "border-primary" : "border-muted"} bg-card`}
                  >
                    <button
                      onClick={() => {
                        setActiveSessionId(s.id);
                        void ensureThumbLoaded(s.id);
                      }}
                      className="w-full text-left"
                    >
                      <div className="flex gap-2">
                        <div className="w-[44px] h-[44px] rounded-md border bg-muted/20 overflow-hidden flex items-center justify-center shrink-0">
                          {thumb ? (
                            <img src={thumb} className="w-full h-full object-cover" alt="thumb" />
                          ) : (
                            <div className="text-[10px] text-muted-foreground">No</div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="text-[10px] text-muted-foreground">{new Date(s.updatedAt || s.createdAt).toLocaleString()}</div>
                          <div className="text-sm font-semibold line-clamp-1">{s.impression || "（印象なし）"}</div>
                          <div className="text-xs text-muted-foreground line-clamp-1">{s.objects || "（具象物なし）"}</div>
                        </div>
                      </div>
                    </button>

                    <div className="mt-2 flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => restoreSession(s)} className="h-8 px-2 gap-1">
                        <CornerUpLeft className="h-4 w-4" />
                        <span className="text-xs">再開</span>
                      </Button>

                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => deleteSession(s.id)}
                        className="h-8 w-8 shrink-0"
                        aria-label="削除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeSession && (
            <div className="mt-3 pt-3 border-t space-y-3">
              <div className="text-xs font-semibold">選択中</div>

              <div className="text-xs whitespace-pre-wrap bg-muted/20 border rounded-lg p-2">
                <div className="font-semibold mb-1">最終解釈</div>
                {activeSession.editedFinalResult || activeSession.finalResult || "（最終解釈なし）"}
              </div>

              <div className="text-xs bg-muted/20 border rounded-lg p-2">
                <div className="font-semibold mb-1">Step3, 記録視点</div>
                {activeSession.s3SavedViews.length === 0 ? (
                  <div className="text-muted-foreground">（なし）</div>
                ) : (
                  <div className="space-y-2">
                    {activeSession.s3SavedViews
                      .slice()
                      .sort((a, b) => b.savedAt - a.savedAt)
                      .slice(0, 5)
                      .map((v, idx) => (
                        <div key={idx} className="text-xs bg-background border rounded-md p-2">
                          <div className="font-semibold">{v.label}</div>
                          <div className="text-muted-foreground">{v.location}</div>
                        </div>
                      ))}
                    {activeSession.s3SavedViews.length > 5 && (
                      <div className="text-[10px] text-muted-foreground">他 {activeSession.s3SavedViews.length - 5} 件</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 左：画像エリア */}
      <div className="w-full md:w-1/2 h-1/2 md:h-full bg-muted/20 flex items-center justify-center p-4 lg:p-12">
        <div className="relative w-full max-w-[500px] aspect-[5/6] bg-white rounded-2xl shadow-xl border border-border flex items-center justify-center overflow-hidden">
          {imageURL ? (
            <img src={imageURL} className="w-full h-full object-contain" alt="Target" />
          ) : (
            <div className="text-center space-y-2">
              <ImageIcon className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground">作品をアップロード</p>
            </div>
          )}
          <input
            type="file"
            className="absolute inset-0 opacity-0 cursor-pointer"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </div>
      </div>

      {/* 右：対話エリア */}
      <div className="w-full md:w-1/2 h-1/2 md:h-full flex flex-col p-4 md:p-8 lg:p-12 overflow-hidden relative">
        <AnimatePresence mode="wait">
          {/* ===== Step 1: 観察 ===== */}
          {step === 1 && (
            <Page key="step1">
              <CardHeader className="px-0 pt-0">
                <CardTitle>Step 1: 観察</CardTitle>
              </CardHeader>
              <CardContent className="px-0 space-y-6 overflow-y-auto">
                <div className="space-y-3">
                  <label className="text-sm font-semibold">1. 絵から受ける全体的な印象は？</label>
                  <Textarea
                    className="min-h-[100px]"
                    value={impression}
                    onChange={(e) => setImpression(e.target.value)}
                    placeholder="例：不安な感じ、静かな感じ..."
                  />
                </div>
                <div className="space-y-3">
                  <label className="text-sm font-semibold">2. 特に気になった「モノ」は？</label>
                  <Textarea
                    className="min-h-[100px]"
                    value={objects}
                    onChange={(e) => setObjects(e.target.value)}
                    placeholder="例：人、オレンジ、鉛筆、山...など"
                  />
                </div>
                <Button onClick={startStep2} disabled={!file || !impression || !objects} className="w-full py-6 shadow-lg">
                  対話を始める
                </Button>
              </CardContent>
            </Page>
          )}

          {/* ===== Step 2: 深掘り ===== */}
          {step === 2 && (
            <Page key="step2">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="text-xl">Step 2: 深掘り</CardTitle>
              </CardHeader>
              <CardContent className="px-0 flex-1 flex flex-col overflow-hidden">
                {!s2CurrentObject ? (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <p className="text-sm text-muted-foreground mb-4">気になった物を1つずつ深掘りしましょう。選択してください。</p>
                    <div className="flex-1 overflow-y-auto py-4">
                      <div className="grid grid-cols-1 gap-3">
                        {s2Cards.map((card, i) => (
                          <button
                            key={i}
                            onClick={() => selectS2Object(card.label)}
                            className="flex items-center justify-between p-4 rounded-xl border-2 border-muted bg-card hover:border-primary hover:bg-primary/5 transition-all text-left group"
                          >
                            <span className="text-base font-semibold group-hover:text-primary">{card.label}</span>
                            {card.completed && <CheckCircle2 className="h-5 w-5 text-green-500" />}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="pt-2 border-t">
                      <Button onClick={finalizeStep2} variant="outline" className="w-full mb-2">
                        Step2を完了
                      </Button>
                      {s2Summary && (
                        <Button onClick={() => prepareStep3()} className="w-full">
                          Step 3：新しい視点を探す
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="flex items-center justify-between mb-4 bg-primary/10 p-3 rounded-lg border border-primary/20">
                      <div>
                        <p className="text-[10px] uppercase font-bold text-primary">深掘り中</p>
                        <p className="text-sm font-bold">{s2CurrentObject}</p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setS2CurrentObject(null)} className="text-xs hover:bg-primary/20">
                        一覧に戻る
                      </Button>
                    </div>

                    <div className="flex-1 overflow-y-auto mb-4 space-y-4 pr-2">
                      {(s2Dialogs[s2CurrentObject] || [])
                        .filter((m) => m.role !== "system" && !m.hidden)
                        .map((m, i) => (
                          <div
                            key={i}
                            className={`p-4 rounded-2xl text-sm max-w-[60%] ${
                              m.role === "user" ? "bg-primary text-primary-foreground ml-auto" : "bg-muted"
                            }`}
                          >
                            {m.content}
                          </div>
                        ))}
                      {loading === 2 && <Loader2 className="animate-spin h-4 w-4 mx-auto" />}
                      <div ref={s2ChatBottom} />
                    </div>

                    <div className="flex gap-2 pt-2 border-t">
                      <Input
                        value={s2Input}
                        onChange={(e) => setS2Input(e.target.value)}
                        placeholder="あなたの考え..."
                        onKeyDown={(e) => e.key === "Enter" && sendS2Chat()}
                      />
                      <Button onClick={sendS2Chat} size="icon">
                        <Wand2 className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" onClick={completeCurrentObject}>
                        完了
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Page>
          )}

          {/* ===== Step 3: 新しい視点 ===== */}
          {step === 3 && (
            <Page key="step3">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="text-xl flex items-center gap-2">
                  <Lightbulb className="w-5 h-5 text-yellow-500" />
                  Step 3: 新しい視点
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  Step1/2で触れられていない「具象物」を推測しました。気になるものを選んでください。
                </p>
              </CardHeader>

              <CardContent className="px-0 flex-1 flex flex-col overflow-hidden">
                {!s3Chosen ? (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    {/* 候補一覧 */}
                    <div className="flex-1 overflow-y-auto py-4">
                      <div className="grid grid-cols-1 gap-3">
                        {s3Candidates.map((cand, i) => (
                          <button
                            key={i}
                            onClick={() => startS3Chat(cand)}
                            className="flex flex-col items-start p-4 rounded-xl border-2 border-muted bg-card hover:border-primary hover:bg-primary/5 transition-all text-left group"
                          >
                            <span className="text-[10px] font-bold text-primary uppercase tracking-wider bg-primary/10 px-2 py-0.5 rounded mb-2">
                              {cand.location}
                            </span>
                            <span className="text-base font-semibold group-hover:text-primary mb-1">{cand.label}</span>
                            <span className="text-sm text-muted-foreground line-clamp-2 italic">「{cand.element}」</span>
                          </button>
                        ))}

                        {loading === 3 && (
                          <div className="flex flex-col items-center justify-center py-10 space-y-3">
                            <Loader2 className="animate-spin h-8 w-8 text-primary" />
                            <p className="text-sm text-muted-foreground">候補を生成中...</p>
                          </div>
                        )}
                      </div>

                      {/* 記録した視点の一覧 */}
                      <div className="mt-6 pt-4 border-t">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-sm font-semibold">記録した視点</p>
                          <p className="text-xs text-muted-foreground">{s3SavedViews.length}件</p>
                        </div>

                        {s3SavedViews.length === 0 ? (
                          <div className="text-xs text-muted-foreground bg-muted/30 border rounded-lg p-3">
                            まだ記録はありません, 対話中に「この視点を記録」を押すとここに残ります。
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 gap-3">
                            {s3SavedViews
                              .slice()
                              .sort((a, b) => b.savedAt - a.savedAt)
                              .map((v, idx) => (
                                <div key={`${v.label}-${idx}`} className="p-4 rounded-xl border bg-card flex flex-col gap-2">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-bold text-primary uppercase tracking-wider bg-primary/10 px-2 py-0.5 rounded">
                                          {v.location}
                                        </span>
                                        <span className="text-[10px] font-bold text-green-600 bg-green-500/10 px-2 py-0.5 rounded">
                                          記録済み
                                        </span>
                                      </div>
                                      <div className="text-base font-semibold mt-1 truncate">{v.label}</div>
                                      <div className="text-sm text-muted-foreground italic line-clamp-2">「{v.element}」</div>
                                      {v.summary && <div className="text-xs text-muted-foreground mt-2 line-clamp-2">要約: {v.summary}</div>}
                                    </div>
                                    <Button variant="outline" size="sm" onClick={() => openSavedView(v)} disabled={!!loading} className="shrink-0">
                                      開く
                                    </Button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="pt-2 border-t space-y-2">
                      <Button onClick={regenerateStep3} variant="outline" className="w-full" disabled={!!loading}>
                        別の新しい視点
                      </Button>

                      {/* Step3 -> Step2 戻る */}
                      <Button
                        onClick={() => {
                          setS3Chosen(null);
                          setS3Msgs([]);
                          setStep(2);
                        }}
                        variant="outline"
                        className="w-full"
                        disabled={!!loading}
                      >
                        Step2に戻る
                      </Button>

                      <Button onClick={generateFinal} variant="secondary" className="w-full" disabled={!!loading}>
                        最終解釈を生成
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="flex items-center justify-between mb-4 bg-primary/10 p-3 rounded-lg border border-primary/20">
                      <div>
                        <p className="text-[10px] uppercase font-bold text-primary">探索中の具象物</p>
                        <p className="text-sm font-bold">{s3Chosen}</p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setS3Chosen(null)} className="text-xs hover:bg-primary/20">
                        戻る
                      </Button>
                    </div>

                    <div className="flex-1 overflow-y-auto mb-4 space-y-4 pr-2">
                      {s3Msgs
                        .filter((m) => m.role !== "system" && !m.hidden)
                        .map((m, i) => (
                          <div
                            key={i}
                            className={`p-4 rounded-2xl text-sm leading-relaxed max-w-[60%] ${
                              m.role === "user" ? "bg-primary text-primary-foreground ml-auto" : "bg-muted shadow-sm"
                            }`}
                          >
                            {m.content}
                          </div>
                        ))}
                      {loading === 3 && <Loader2 className="animate-spin h-4 w-4 mx-auto text-muted-foreground" />}
                      <div ref={s3ChatBottom} />
                    </div>

                    <div className="space-y-3 pt-2 border-t">
                      {s3Toast && <div className="text-xs px-3 py-2 rounded-lg bg-muted/60 border">{s3Toast}</div>}

                      <div className="flex gap-2">
                        <Input
                          className="py-6 text-base"
                          value={s3Input}
                          onChange={(e) => setS3Input(e.target.value)}
                          placeholder="どう見えますか？"
                          onKeyDown={(e) => e.key === "Enter" && sendS3Chat()}
                        />
                        <Button onClick={sendS3Chat} size="icon" className="h-[52px] w-[52px] shrink-0">
                          <Wand2 className="h-5 w-5" />
                        </Button>
                      </div>

                      <div className="flex gap-2">
                        <Button variant="outline" className="w-full" onClick={recordS3Summary} disabled={savingS3 || !!loading}>
                          {savingS3 ? (
                            <span className="inline-flex items-center gap-2">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              記録中...
                            </span>
                          ) : (
                            "この視点を記録"
                          )}
                        </Button>

                        <Button onClick={generateFinal} variant="secondary" className="w-full" disabled={savingS3}>
                          最終解釈を生成
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Page>
          )}

          {/* ===== Step 4: 最終解釈 ===== */}
          {step === 4 && (
            <Page key="step4">
              <CardHeader className="px-0 pt-0">
                <CardTitle>あなたの解釈</CardTitle>
              </CardHeader>
              <CardContent className="px-0 space-y-4 overflow-y-auto">
                {loading === 4 ? (
                  <div className="flex flex-col items-center justify-center py-20 space-y-4">
                    <Loader2 className="animate-spin h-12 w-12 text-primary" />
                    <p className="text-sm text-muted-foreground">最終解釈を生成中...</p>
                  </div>
                ) : (
                  <>
                    {!isEditingFinal ? (
                      <div className="p-6 bg-muted/30 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap">
                        {editedFinalResult || finalResult || "生成中..."}
                      </div>
                    ) : (
                      <Textarea
                        className="min-h-[300px] p-6 text-sm leading-relaxed"
                        value={editedFinalResult}
                        onChange={(e) => setEditedFinalResult(e.target.value)}
                      />
                    )}

                    <div className="flex gap-2">
                      {!isEditingFinal ? (
                        <Button variant="outline" className="w-full" onClick={() => setIsEditingFinal(true)}>
                          解釈文を編集
                        </Button>
                      ) : (
                        <Button variant="outline" className="w-full" onClick={() => setIsEditingFinal(false)}>
                          編集を完了
                        </Button>
                      )}
                    </div>

                    {/* 対話履歴の参照UI */}
                    <div className="border-t pt-4 mt-6 space-y-4">
                      <h3 className="text-sm font-semibold">対話履歴を振り返る</h3>

                      {/* Step2の対話履歴 */}
                      <div className="space-y-2">
                        <button
                          onClick={() => setShowS2History(!showS2History)}
                          className="w-full flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                        >
                          <span className="text-sm font-semibold">Step2での対話内容</span>
                          {showS2History ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </button>
                        {showS2History && (
                          <div className="pl-4 space-y-2">
                            {Object.keys(s2Dialogs).map((objName, i) => (
                              <button
                                key={i}
                                onClick={() => setSelectedHistoryObject(selectedHistoryObject === `s2-${objName}` ? null : `s2-${objName}`)}
                                className="block w-full text-left text-sm p-2 rounded hover:bg-muted/50 transition-colors"
                              >
                                ・{objName}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Step3の対話履歴 */}
                      {Object.keys(s3Dialogs).length > 0 && (
                        <div className="space-y-2">
                          <button
                            onClick={() => setShowS3History(!showS3History)}
                            className="w-full flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                          >
                            <span className="text-sm font-semibold">Step3での対話内容</span>
                            {showS3History ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                          {showS3History && (
                            <div className="pl-4 space-y-2">
                              {Object.keys(s3Dialogs).map((label, i) => (
                                <button
                                  key={i}
                                  onClick={() => setSelectedHistoryObject(selectedHistoryObject === `s3-${label}` ? null : `s3-${label}`)}
                                  className="block w-full text-left text-sm p-2 rounded hover:bg-muted/50 transition-colors"
                                >
                                  ・{label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* 選択した対話の内容表示 */}
                      {selectedHistoryObject && (
                        <div className="p-4 bg-muted/30 rounded-lg space-y-3 max-h-[300px] overflow-y-auto">
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-xs font-bold text-primary">
                              {selectedHistoryObject.startsWith("s2-") ? selectedHistoryObject.replace("s2-", "") : selectedHistoryObject.replace("s3-", "")}
                              の対話
                            </h4>
                            <Button variant="ghost" size="sm" onClick={() => setSelectedHistoryObject(null)} className="h-6 px-2 text-xs">
                              閉じる
                            </Button>
                          </div>

                          {selectedHistoryObject.startsWith("s2-") && (
                            <>
                              {(s2Dialogs[selectedHistoryObject.replace("s2-", "")] || [])
                                .filter((m) => m.role !== "system" && !m.hidden)
                                .map((m, i) => (
                                  <div key={i} className={`p-3 rounded-lg text-xs ${m.role === "user" ? "bg-primary/20 ml-auto max-w-[80%]" : "bg-background max-w-[80%]"}`}>
                                    {m.content}
                                  </div>
                                ))}
                            </>
                          )}

                          {selectedHistoryObject.startsWith("s3-") && (
                            <>
                              {(() => {
                                const key = selectedHistoryObject.replace("s3-", "");
                                const msgs = s3Dialogs[key] || [];
                                return msgs
                                  .filter((m) => m.role !== "system" && !m.hidden)
                                  .map((m, i) => (
                                    <div key={i} className={`p-3 rounded-lg text-xs ${m.role === "user" ? "bg-primary/20 ml-auto max-w-[80%]" : "bg-background max-w-[80%]"}`}>
                                      {m.content}
                                    </div>
                                  ));
                              })()}
                            </>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Step4 -> Step3/Step2 戻る */}
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          setSelectedHistoryObject(null);
                          setShowS2History(false);
                          setShowS3History(false);

                          setS3Chosen(null);
                          setS3Msgs([]);
                          setStep(3);
                        }}
                        disabled={!!loading}
                      >
                        Step3に戻る
                      </Button>

                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          setSelectedHistoryObject(null);
                          setShowS2History(false);
                          setShowS3History(false);

                          setS2CurrentObject(null);
                          setStep(2);
                        }}
                        disabled={!!loading}
                      >
                        Step2に戻る
                      </Button>
                    </div>

                    {/* 新しい作品へ: 現在を履歴に保存(復元中なら上書き更新)してリセット */}
                    <Button
                      onClick={async () => {
                        const ok = window.confirm(
                          currentSessionId
                            ? "現在の鑑賞内容を, この履歴に上書き更新してから新しい作品を始めますか？"
                            : "現在の鑑賞内容を履歴に保存して, 新しい作品の鑑賞を始めますか？"
                        );
                        if (!ok) return;
                        await saveOrUpdateSession();
                        resetToStep1();
                        setShowHistoryPanel(true);
                        setToast("✅ 履歴を更新しました");
                      }}
                      variant="outline"
                      className="w-full mt-4"
                    >
                      新しい作品を鑑賞する
                    </Button>
                  </>
                )}
              </CardContent>
            </Page>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="h-full flex flex-col">
      {children}
    </motion.div>
  );
}
