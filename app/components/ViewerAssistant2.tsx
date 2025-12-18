"use client";

import React, { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Loader2, Upload, Wand2, Lightbulb, FileText, Image as ImageIcon } from "lucide-react";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type SendChatArgs = { messages: ChatMessage[]; imageFile?: File | null };
type SendChatFn = (args: SendChatArgs) => Promise<string>;

/* ====== Step2変更（追加）: 候補型 ====== */
type Step2Candidate = {
  label: string;      // ボタン表示用（短い）
  element: string;    // 具体要素（少し説明）
  location: string;   // 位置（例：左上/中央/手前など）
  evidence: string;   // なぜ別視点として有効か（短く）
};

async function defaultSendChat({ messages, imageFile }: SendChatArgs): Promise<string> {
  const fd = new FormData();
  fd.append("messages", JSON.stringify(messages));
  if (imageFile) fd.append("image", imageFile);

  const res = await fetch("/api/chat", { method: "POST", body: fd });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`API error: ${res.status} ${t}`);
  }
  const data = (await res.json()) as { text: string };
  return data.text;
}

/* =======================
   Step1 prompts
======================= */
function step1SystemPrompt() {
  return [
    "あなたは美術鑑賞の対話アシスタントです。",
    "目的：鑑賞者の“初期印象”の原因（根拠）を、鑑賞者の言葉を中心に対話で明確化する。",
    "ルール：断定しない。作者意図・外部知識・一般論の押し付けは禁止。",
    "返答は短く、基本は『要約(1文)+質問(1文)』。",
  ].join("\n");
}

function buildStep1KickoffMessages(freeText: string): ChatMessage[] {
  return [
    { role: "system", content: step1SystemPrompt() },
    {
      role: "user",
      content:
        `この絵を見て感じたこと（初期印象）：\n${freeText.trim() || "(まだ言葉にできない)"}\n\n` +
        "まず印象を短く確認し、次に質問を1つしてください。",
    },
  ];
}

function buildStep1SummaryMessages(step1Chat: ChatMessage[]): ChatMessage[] {
  return [
    { role: "system", content: "あなたは鑑賞者の言葉を尊重して要約する編集者です。" },
    {
      role: "user",
      content:
        "以下の対話をもとに、鑑賞者の初期印象の根拠を2〜3文で『鑑賞者の言葉として』まとめてください。\n" +
        "禁止：作者意図の断定、外部知識、一般論。\n\n" +
        step1Chat
          .filter((m) => m.role !== "system")
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
          .join("\n\n"),
    },
  ];
}

/* =======================
   Step2 prompts（要件反映）
======================= */

/* ====== Step2変更（差し替え）: 画像駆動の候補生成（JSON） ====== */
function buildStep2CandidateMessages(step1Summary: string): ChatMessage[] {
  const SYSTEM =
    "あなたは美術鑑賞の支援者です。必ず画像を観察し、画像に実在する視覚要素に基づいて別視点を提案してください。外部知識は禁止。";

  const INSTRUCTIONS = `
次の手順で行ってください。
(1) 画像を観察し、この絵に描かれている『具体的な視覚要素』を8〜12個抽出する。
    - 物体/人物/背景要素/光/影/色の塊/反復/奥行き/空白/境界線 など、"画像に見えるもの" に限定。
    - 抽象カテゴリ（構図/色彩/雰囲気 など）だけで終わらせない。必ず"何が"を含める。
(2) Step1まとめで言及された要素と重複しない候補を3〜4個選ぶ（できるだけ別物）。
(3) それぞれにボタン用の短い label（最大8文字）を付ける。
(4) 以下の JSON だけを返す（説明文禁止）。

出力JSON形式：
{
  "candidates": [
    { "label": "...", "element": "...", "location": "...", "evidence": "..." }
  ]
}

制約：
- label は短く（最大8文字）、UIボタンに載る前提。
- element/location/evidence は短く具体的に。
- Step1まとめに出てくる物体・人物・建物・表情などと重複しないよう努力する。
`;

  const user = `Step1のまとめ（重複回避の参考）:\n${(step1Summary || "").slice(0, 1200)}\n\n${INSTRUCTIONS}`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// 2) Step2：選択した視覚要素について協調的に会話（質問→要約→質問）
function step2SystemPrompt() {
  return [
    "あなたは美術鑑賞の対話アシスタントです。",
    "目的：選択された『別の視覚要素』に注目し、そこで生じる印象と根拠を、鑑賞者と協調的に言語化する。",
    "ルール：断定しない。作者意図・外部知識・一般論は禁止。",
    "返答は短く『要約(1文)+質問(1文)』を基本にする。",
    "質問は根拠の明確化（どこ？何が？どんな感じ？）に寄せる。",
  ].join("\n");
}

/* ====== Step2変更（差し替え）: kickoffに候補詳細を渡す ====== */
function buildStep2ChatKickoffMessages(step1Summary: string, cand: Step2Candidate): ChatMessage[] {
  return [
    { role: "system", content: step2SystemPrompt() },
    {
      role: "user",
      content:
        `Step1のまとめ（参考）:\n${(step1Summary || "").slice(0, 900)}\n\n` +
        `Step2で注目する別視点（画像から抽出）:\n` +
        `- label: ${cand.label}\n` +
        `- element: ${cand.element}\n` +
        `- location: ${cand.location}\n` +
        (cand.evidence ? `- hint: ${cand.evidence}\n\n` : "\n") +
        "この要素に注目して、ユーザの印象と根拠を協調的に言語化してください。まず『印象（感じ）』を短く確認し、次に『根拠（どこ/何が）』を1つ質問してください。",
    },
  ];
}

// 3) Step2：対話ログから「印象＋根拠」のまとめを作る（Step3へ渡す）
function buildStep2SummaryMessages(chosenElement: string, step2Chat: ChatMessage[]): ChatMessage[] {
  return [
    { role: "system", content: "あなたは鑑賞者の言葉を尊重して要約する編集者です。" },
    {
      role: "user",
      content:
        `以下の対話は、別の視覚要素「${chosenElement}」に注目して、印象と根拠を言語化したものです。\n` +
        "鑑賞者の言葉として、2〜3文で『印象＋根拠』をまとめてください。\n" +
        "禁止：作者意図の断定、外部知識、一般論。\n\n" +
        step2Chat
          .filter((m) => m.role !== "system")
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
          .join("\n\n"),
    },
  ];
}

/* =======================
   Step3 prompt
======================= */
function buildStep3Messages(step1Summary: string, chosenElement: string | null, step2Summary: string | null): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "あなたは鑑賞者の言語化を支援するアシスタントです。鑑賞者の主体的な感じ方を核に、示唆的・簡潔な解釈文（2〜3文）を提案してください。禁止: 作者意図の断定、外部知識、一般論。",
    },
    {
      role: "user",
      content:
        `Step1まとめ:\n${(step1Summary || "").slice(0, 900)}\n\n` +
        `Step2の注目要素: ${chosenElement ?? "(なし)"}\n` +
        `Step2まとめ:\n${step2Summary ?? "(なし)"}\n`,
    },
  ];
}

/* =======================
   small utils
======================= */
function parseLinesToCandidates(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^-+\s*/, "").trim())
    .filter(Boolean);

  const picked = lines.filter((l) => l.length >= 1 && l.length <= 10);
  const uniq = Array.from(new Set(picked));
  return uniq.slice(0, 6);
}

/* ====== Step2変更（追加）: JSONパース（壊れても落ちない） ====== */
function safeParseStep2Candidates(text: string): Step2Candidate[] {
  try {
    const obj = JSON.parse(text);
    const arr = obj?.candidates;
    if (Array.isArray(arr)) {
      const cleaned = arr
        .map((x: any) => ({
          label: String(x.label ?? "").trim(),
          element: String(x.element ?? "").trim(),
          location: String(x.location ?? "").trim(),
          evidence: String(x.evidence ?? "").trim(),
        }))
        .filter((x) => x.label && x.element && x.location);
      if (cleaned.length) return cleaned.slice(0, 6);
    }
  } catch {
    // fallthrough
  }

  const lines = text
    .split("\n")
    .map((l) => l.replace(/^-+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 4);

  return lines.map((l) => ({
    label: l.slice(0, 8),
    element: l,
    location: "（不明）",
    evidence: "",
  }));
}

/* =======================
   Component
======================= */
export default function ViewerAssistant3({ sendChat = defaultSendChat }: { sendChat?: SendChatFn }) {
  // left image
  const [file, setFile] = useState<File | null>(null);
  const [imageURL, setImageURL] = useState("");

  // step control
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [loading, setLoading] = useState<false | 1 | 2 | 3>(false);

  // step0
  const [freeText, setFreeText] = useState("");

  // step1 chat
  const [s1Msgs, setS1Msgs] = useState<ChatMessage[]>([]);
  const [s1Input, setS1Input] = useState("");
  const [s1Summary, setS1Summary] = useState("");
  const [s1Confirming, setS1Confirming] = useState(false);

  // Step1：任意メモ（残してOK）
  const [note1, setNote1] = useState("");

  // step2（要件反映）
  /* ====== Step2変更（差し替え）: string[] -> Step2Candidate[] ====== */
  const [s2Candidates, setS2Candidates] = useState<Step2Candidate[]>([]);
  const [s2ChosenElement, setS2ChosenElement] = useState<string | null>(null);

  const [s2Msgs, setS2Msgs] = useState<ChatMessage[]>([]);
  const [s2Input, setS2Input] = useState("");

  const [s2Summary, setS2Summary] = useState<string>(""); // Step2確定まとめ（Step3へ）
  const [s2Confirming, setS2Confirming] = useState(false);

  // Step2：任意メモ
  const [note2, setNote2] = useState("");

  // step3
  const [finalText, setFinalText] = useState("");

  // image URL
  useEffect(() => {
    if (!file) {
      setImageURL("");
      return;
    }
    const url = URL.createObjectURL(file);
    setImageURL(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /* ---------- Step1 actions ---------- */
  const startStep1 = async () => {
    if (!file) return;
    const kickoff = buildStep1KickoffMessages(freeText);

    setS1Confirming(false);
    setS1Summary("");
    setS1Msgs(kickoff);

    setLoading(1);
    try {
      const out = await sendChat({ messages: kickoff, imageFile: file });
      setS1Msgs([...kickoff, { role: "assistant", content: out }]);
    } finally {
      setLoading(false);
    }
  };

  const sendStep1Chat = async () => {
    if (!file) return;
    const text = s1Input.trim();
    if (!text) return;

    const next = [...s1Msgs, { role: "user", content: text } as ChatMessage];
    setS1Msgs(next);
    setS1Input("");

    setLoading(1);
    try {
      const out = await sendChat({ messages: next, imageFile: file });
      setS1Msgs([...next, { role: "assistant", content: out }]);
    } finally {
      setLoading(false);
    }
  };

  const makeStep1Summary = async () => {
    if (!file) return;
    setLoading(1);
    try {
      const out = await sendChat({ messages: buildStep1SummaryMessages(s1Msgs), imageFile: file });
      setS1Summary(out);
      setS1Confirming(true);
    } finally {
      setLoading(false);
    }
  };

  /* ---------- Step2 actions（要件反映） ---------- */

  // Step2に入った直後：候補を自動生成
  const generateStep2Candidates = async () => {
    if (!file) return;
    if (!s1Summary.trim()) return;

    setLoading(2);
    try {
      const out = await sendChat({ messages: buildStep2CandidateMessages(s1Summary), imageFile: file });

      /* ====== Step2変更（差し替え）: JSONパース ====== */
      const cands = safeParseStep2Candidates(out);
      setS2Candidates(
        cands.length
          ? cands
          : [
              { label: "背景", element: "背景の要素", location: "全体", evidence: "" },
              { label: "光", element: "光の当たり", location: "不明", evidence: "" },
              { label: "影", element: "影の形", location: "不明", evidence: "" },
            ]
      );
    } finally {
      setLoading(false);
    }
  };

  // ボタン選択：協調対話を開始（キックオフでAIに最初の問いを作らせる）
  /* ====== Step2変更（差し替え）: cand受け取り ====== */
  const chooseStep2Element = async (cand: Step2Candidate) => {
    if (!file) return;
    setS2ChosenElement(cand.label);
    setS2Confirming(false);
    setS2Summary("");
    setNote2("");
    setS2Input("");

    const kickoff = buildStep2ChatKickoffMessages(s1Summary, cand);
    setS2Msgs(kickoff);

    setLoading(2);
    try {
      const out = await sendChat({ messages: kickoff, imageFile: file });
      setS2Msgs([...kickoff, { role: "assistant", content: out }]);
    } finally {
      setLoading(false);
    }
  };

  // Step2 チャット送信
  const sendStep2Chat = async () => {
    if (!file) return;
    if (!s2ChosenElement) return;

    const text = s2Input.trim();
    if (!text) return;

    const next = [...s2Msgs, { role: "user", content: text } as ChatMessage];
    setS2Msgs(next);
    setS2Input("");

    setLoading(2);
    try {
      const out = await sendChat({ messages: next, imageFile: file });
      setS2Msgs([...next, { role: "assistant", content: out }]);
    } finally {
      setLoading(false);
    }
  };

  // Step2 まとめ生成（確定してStep3へ渡す）
  const makeStep2Summary = async () => {
    if (!file) return;
    if (!s2ChosenElement) return;

    setLoading(2);
    try {
      const out = await sendChat({
        messages: buildStep2SummaryMessages(s2ChosenElement, s2Msgs),
        imageFile: file,
      });
      setS2Summary(out);
      setS2Confirming(true);
    } finally {
      setLoading(false);
    }
  };

  // Step2開始直後に候補提示（要件）
  useEffect(() => {
    if (step === 2) {
      // 初期化（step2に入るたびに候補を作り直す）
      setS2Candidates([]);
      setS2ChosenElement(null);
      setS2Msgs([]);
      setS2Input("");
      setS2Summary("");
      setS2Confirming(false);

      // 直後に自動生成
      void generateStep2Candidates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /* ---------- Step3 ---------- */
  const runStep3 = async () => {
    if (!file) return;
    setLoading(3);
    try {
      const out = await sendChat({
        messages: buildStep3Messages(s1Summary, s2ChosenElement, s2Summary),
        imageFile: file,
      });
      setFinalText(out);
    } finally {
      setLoading(false);
    }
  };

  /* =======================
     UI
  ======================= */
  return (
    <div className="w-full h-screen overflow-hidden grid grid-cols-1 md:grid-cols-2 bg-background max-w-[1600px] mx-auto px-2 md:px-4">
      {/* Left image fixed size */}
      <div className="relative h-[40vh] md:h-screen md:sticky md:top-0 bg-muted/20 flex items-center justify-center p-2 md:p-4">
        <div className="w-[500px] h-[600px] rounded-2xl overflow-hidden shadow-sm bg-black/5 flex items-center justify-center relative">
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
          {imageURL ? (
            <img src={imageURL} alt="preview" className="w-full h-full object-contain pointer-events-none" />
          ) : (
            <div className="text-muted-foreground flex flex-col items-center gap-2 text-sm pointer-events-none">
              <ImageIcon className="h-6 w-6" />
              <p>ここをクリックして画像ファイルを選択</p>
              <p className="text-xs">.jpg / .png など</p>
            </div>
          )}
        </div>
      </div>

      {/* Right */}
      <div className="h-screen p-4 md:p-6 overflow-hidden flex flex-col">
        <Header step={step} onJump={setStep} />

        <div className="flex-1 flex items-center justify-center overflow-hidden">
          <div className="relative w-full max-w-[720px] h-full md:h-[64vh] overflow-hidden">
            <AnimatePresence mode="popLayout">
              {/* Step0 */}
              {step === 0 && (
                <Page key="p0">
                  <CardHeader className="border-0">
                    <CardTitle className="flex items-center gap-2">
                      <Upload className="h-5 w-5" /> 左の絵を見て思ったことを書いてください
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <label className="text-sm text-muted-foreground">自由記述</label>
                    <Textarea value={freeText} onChange={(e) => setFreeText(e.target.value)} className="h-40" />
                    <Button
                      onClick={async () => {
                        setStep(1);
                        await startStep1();
                      }}
                      disabled={!file || !freeText.trim()}
                    >
                      次へ（対話を開始）
                    </Button>
                  </CardContent>
                </Page>
              )}

              {/* Step1 */}
              {step === 1 && (
                <Page key="p1">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Wand2 className="h-5 w-5" /> Step 1：根拠を対話で明確化
                    </CardTitle>
                  </CardHeader>

                  <CardContent className="flex flex-col h-full gap-3">
                    <div className="flex-1 overflow-y-auto rounded-lg border bg-muted/20 p-3 space-y-3">
                      {s1Msgs
                        .filter((m) => m.role !== "system")
                        .map((m, i) => (
                          <div
                            key={i}
                            className={`max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                              m.role === "user" ? "ml-auto bg-background border" : "mr-auto bg-muted/40 border"
                            }`}
                          >
                            {m.content}
                          </div>
                        ))}
                      {loading === 1 && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>考え中...</span>
                        </div>
                      )}
                    </div>

                    {!s1Confirming && (
                      <div className="flex gap-2">
                        <Input
                          value={s1Input}
                          onChange={(e) => setS1Input(e.target.value)}
                          placeholder="思ったことをそのまま書いてOK"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void sendStep1Chat();
                            }
                          }}
                        />
                        <Button onClick={sendStep1Chat} disabled={!s1Input.trim() || loading === 1}>
                          送信
                        </Button>
                        <Button variant="outline" onClick={makeStep1Summary} disabled={loading === 1 || s1Msgs.length < 3}>
                          まとめへ
                        </Button>
                      </div>
                    )}

                    {s1Confirming && (
                      <div className="space-y-2">
                        <div className="text-sm text-muted-foreground">暫定まとめ（編集OK）</div>
                        <Textarea value={s1Summary} onChange={(e) => setS1Summary(e.target.value)} className="h-28" />
                        <div className="flex gap-2">
                          <Button variant="secondary" onClick={() => setS1Confirming(false)}>
                            もう少し対話する
                          </Button>
                          <Button onClick={() => setStep(2)} disabled={!s1Summary.trim()}>
                            このまとめで次へ
                          </Button>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <label className="text-sm text-muted-foreground">あなたのメモ（任意）</label>
                      <Textarea value={note1} onChange={(e) => setNote1(e.target.value)} className="h-20" />
                    </div>

                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={() => setStep(0)}>
                        戻る
                      </Button>
                    </div>
                  </CardContent>
                </Page>
              )}

              {/* Step2（要件反映：自動提示＋ボタン選択＋協調対話） */}
              {step === 2 && (
                <Page key="p2">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Lightbulb className="h-5 w-5" /> Step 2：別の視覚要素に注目する
                    </CardTitle>
                  </CardHeader>

                  <CardContent className="flex flex-col h-full gap-3">
                    {/* 候補（自動提示） */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="text-sm text-muted-foreground">
                          Step1で着目した要素とは別の視覚要素を提案します（ボタンで選択）
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={generateStep2Candidates}
                          disabled={loading === 2 || !s1Summary.trim()}
                        >
                          再提案
                        </Button>
                      </div>

                      {loading === 2 && s2Candidates.length === 0 && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>別視点を生成中...</span>
                        </div>
                      )}

                      {/* ====== Step2変更（差し替え）: 候補ボタン（label表示＋titleに詳細） ====== */}
                      {s2Candidates.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {s2Candidates.map((c) => (
                            <Button
                              key={`${c.label}-${c.element}`}
                              size="sm"
                              variant={s2ChosenElement === c.label ? "default" : "outline"}
                              onClick={() => void chooseStep2Element(c)}
                              disabled={loading === 2}
                              title={`${c.element} / ${c.location}`}
                            >
                              {c.label}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 協調対話（選択後に表示） */}
                    {s2ChosenElement && (
                      <>
                        <div className="flex-1 overflow-y-auto rounded-lg border bg-muted/20 p-3 space-y-3">
                          {s2Msgs
                            .filter((m) => m.role !== "system")
                            .map((m, i) => (
                              <div
                                key={i}
                                className={`max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                                  m.role === "user" ? "ml-auto bg-background border" : "mr-auto bg-muted/40 border"
                                }`}
                              >
                                {m.content}
                              </div>
                            ))}
                          {loading === 2 && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              <span>考え中...</span>
                            </div>
                          )}
                        </div>

                        {!s2Confirming && (
                          <div className="flex gap-2">
                            <Input
                              value={s2Input}
                              onChange={(e) => setS2Input(e.target.value)}
                              placeholder="この視点で感じた印象や根拠を書いてOK"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void sendStep2Chat();
                                }
                              }}
                            />
                            <Button onClick={sendStep2Chat} disabled={!s2Input.trim() || loading === 2}>
                              送信
                            </Button>
                            <Button
                              variant="outline"
                              onClick={makeStep2Summary}
                              disabled={loading === 2 || s2Msgs.filter((m) => m.role !== "system").length < 3}
                            >
                              まとめへ
                            </Button>
                          </div>
                        )}

                        {s2Confirming && (
                          <div className="space-y-2">
                            <div className="text-sm text-muted-foreground">
                              Step2まとめ（印象＋根拠 / 編集OK）
                            </div>
                            <Textarea value={s2Summary} onChange={(e) => setS2Summary(e.target.value)} className="h-28" />
                            <div className="flex gap-2">
                              <Button variant="secondary" onClick={() => setS2Confirming(false)}>
                                もう少し対話する
                              </Button>
                              <Button onClick={() => setStep(3)} disabled={!s2Summary.trim()}>
                                このまとめで次へ
                              </Button>
                            </div>
                          </div>
                        )}

                        <div className="space-y-2">
                          <label className="text-sm text-muted-foreground">あなたのメモ（任意）</label>
                          <Textarea value={note2} onChange={(e) => setNote2(e.target.value)} className="h-20" />
                        </div>
                      </>
                    )}

                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={() => setStep(1)}>
                        戻る
                      </Button>
                    </div>
                  </CardContent>
                </Page>
              )}

              {/* Step3 */}
              {step === 3 && (
                <Page key="p3">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <FileText className="h-5 w-5" /> Step 3：解釈の統合
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2">
                      <Button onClick={runStep3} disabled={loading === 3 || !s1Summary.trim() || !s2Summary.trim()}>
                        {loading === 3 ? <Loader2 className="h-4 w-4 animate-spin" /> : "生成"}
                      </Button>
                      <Button variant="secondary" onClick={() => setStep(2)}>
                        戻る
                      </Button>
                    </div>

                    {finalText && (
                      <>
                        <Textarea value={finalText} onChange={(e) => setFinalText(e.target.value)} className="h-40" />
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" onClick={() => navigator.clipboard.writeText(finalText)}>
                            コピー
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => {
                              const blob = new Blob([finalText], { type: "text/plain;charset=utf-8" });
                              const a = document.createElement("a");
                              a.href = URL.createObjectURL(blob);
                              a.download = "interpretation.txt";
                              a.click();
                            }}
                          >
                            テキストで保存
                          </Button>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Page>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =======================
   UI helpers
======================= */
function Page({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="absolute inset-0"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.18 }}
    >
      <Card className="w-full h-full overflow-hidden">
        <div className="flex flex-col h-full overflow-y-auto">{children}</div>
      </Card>
    </motion.div>
  );
}

function Header({ step, onJump }: { step: 0 | 1 | 2 | 3; onJump: (s: 0 | 1 | 2 | 3) => void }) {
  if (step === 0) return null;
  const items = [
    { n: 0 as const, label: "初期入力" },
    { n: 1 as const, label: "根拠対話" },
    { n: 2 as const, label: "別視点" },
    { n: 3 as const, label: "解釈統合" },
  ];
  return (
    <div className="flex items-center gap-2 pb-2">
      {items.map((it, i) => (
        <React.Fragment key={it.n}>
          <Button size="sm" variant={step === it.n ? "default" : "outline"} onClick={() => onJump(it.n)}>
            {it.label}
          </Button>
          {i < items.length - 1 && <Separator className="mx-1 hidden md:block" />}
        </React.Fragment>
      ))}
    </div>
  );
}
