"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Loader2, Upload, Wand2, Lightbulb, FileText, Image as ImageIcon, X } from "lucide-react";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// ✅ 画像も渡せる sendChat 型
type SendChatArgs = { messages: ChatMessage[]; imageFile?: File | null };
type SendChatFn = (args: SendChatArgs) => Promise<string>;

// ✅ 本番用 sendChat（/api/chat に multipart で送る）
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

// ===== Step1（完全チャット）プロンプト =====
function step1SystemPrompt() {
  return [
    "あなたは美術鑑賞の対話アシスタントです。",
    "目的：鑑賞者の初期印象を、鑑賞者の言葉を中心に対話で深め、根拠（どこを見て／何がそう感じさせる）を明確化すること。",
    "",
    "方針：会話は短く刻むが、深掘りの段階を踏む（合計で最低5往復を目指す）。",
    "",
    "会話の型（繰り返し運用）：",
    "1) 鑑賞者の直前発話を短く言い換えて確認（1文）",
    "2) 次のいずれかの質問を1つだけ投げる（1文）",
    "   - 位置質問：『その印象は、絵のどのあたりで強い？（上/下/中央/端 など）』",
    "   - 根拠質問：『具体的に何がそう感じさせる？（形/色/光/距離/表情/配置 など）』",
    "   - 比較質問：『もし◯◯が違ったら、印象は変わりそう？（色が明るい等）』",
    "   - 言語化補助：『その感じは、別の言葉にすると？（例：ざわざわ/息苦しい/静か 等）』",
    "3) 3往復に1回だけ、ここまでの要点を箇条書きで1〜2点まとめる（短く）。",
    "",
    "禁止：作者意図の断定、外部知識、一般論の押し付け。",
    "出力は基本2文。箇条書きまとめを出す場合でも全体で80字〜160字程度に抑える。",
  ].join("\n");
}


function buildStep1KickoffMessages(freeText: string): ChatMessage[] {
  return [
    { role: "system", content: step1SystemPrompt() },
    {
      role: "user",
      content:
        `この絵を見て感じたこと（初期印象）：\n${freeText.trim() || "(まだ言葉にできない)"}\n\n` +
        "まず私の印象を短く確認して、次に質問を1つしてください。",
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

// ===== Step2/3 プロンプト（あなたの既存方針に合わせた軽量版）=====

// Step2: カテゴリ候補（短語）
function buildStep2CategoryMessages(step1Summary: string): ChatMessage[] {
  const SYSTEM =
    "あなたは鑑賞者の視点を拡張する支援者です。前段の内容と重ならない『別の観点カテゴリ』候補を3〜6個、短い名詞だけで出してください。";
  const INSTRUCTIONS =
    "出力は各行1語〜2語の短いカテゴリ名のみ。説明文は書かない（例: 構図 / 光 / 空間 / リズム / 反復 / 余白 など）。";
  const user = `前段（Step1のまとめ）:\n${(step1Summary || "").slice(0, 1200)}\n${INSTRUCTIONS}`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// Step2: 選択カテゴリ深掘り（2〜3文）
function buildStep2DrillMessages(
  category: string,
  step1Summary: string,
  freeText: string,
  note1: string
): ChatMessage[] {
  const SYSTEM =
    "あなたは鑑賞者の視点を深める支援者です。鑑賞者の感じ方と気づきを最優先し、選ばれた観点から、示唆的に2〜3文で掘り下げてください。断定や外部知識は避けます。";
  const user =
    `選択カテゴリ: ${category}\n` +
    `Step1のまとめ:\n${(step1Summary || "").slice(0, 900)}\n\n` +
    `鑑賞者の自由記述（初期）: ${freeText.trim() || "(なし)"}\n` +
    `鑑賞者のメモ（Step1）: ${note1.trim() || "(なし)"}\n\n` +
    "要件: 鑑賞者の語り口に寄り添い、仮説として2〜3文。過度に一般化しない。";
  return [{ role: "system", content: SYSTEM }, { role: "user", content: user }];
}

// Step3: 統合（2〜3文）
function buildStep3Messages(step1Summary: string, chosenCategory: string | null, drillText: string | null, note2: string): ChatMessage[] {
  const SYSTEM =
    "あなたは鑑賞者の言語化を支援するアシスタントです。鑑賞者の主体的な感じ方を核に、示唆的・簡潔な解釈文（2〜3文）を提案してください。";
  const user =
    `Step1のまとめ:\n${(step1Summary || "").slice(0, 900)}\n\n` +
    `選択カテゴリ: ${chosenCategory ?? "(なし)"}\n` +
    `カテゴリ深掘り:\n${drillText ?? "(なし)"}\n\n` +
    `鑑賞者のメモ（Step2）: ${note2.trim() || "(なし)"}\n\n` +
    "禁止: 作者意図の断定、外部知識、一般論の押し付け。";
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// ===== 文字列パース =====
function parseCategories(text: string): string[] {
  const lines = text
    .split("\n")
    .flatMap((l) => l.split(/[、,\/]|・/))
    .map((l) => l.replace(/^-+\s*/, "").trim())
    .filter(Boolean);

  const picked = lines.filter((l) => l.length >= 1 && l.length <= 10);
  const uniq = Array.from(new Set(picked.map((s) => s.replace(/\s+/g, ""))));
  return uniq.slice(0, 10);
}

// ===== メイン =====
export default function ViewerAssistant3({ sendChat = defaultSendChat }: { sendChat?: SendChatFn }) {
  // 左：画像
  const [file, setFile] = useState<File | null>(null);
  const [imageURL, setImageURL] = useState("");

  // 右：入力（Step0で入力する初期印象）
  const [freeText, setFreeText] = useState("");

  // 右：状態
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [loading, setLoading] = useState<false | 1 | 2 | 3>(false);

  // Step1（完全チャット）
  const [s1Msgs, setS1Msgs] = useState<ChatMessage[]>([]);
  const [s1Input, setS1Input] = useState("");
  const [s1Summary, setS1Summary] = useState("");      // 暫定まとめ（確定してStep2へ）
  const [s1Confirming, setS1Confirming] = useState(false);
  const [note1, setNote1] = useState("");              // Step1ユーザメモ（任意）

  // Step2
  const [categoriesRaw, setCategoriesRaw] = useState("");
  const categories = useMemo(() => parseCategories(categoriesRaw), [categoriesRaw]);
  const [chosenCategory, setChosenCategory] = useState<string | null>(null);
  const [drillText, setDrillText] = useState<string | null>(null);
  const [note2, setNote2] = useState("");              // Step2ユーザメモ（任意）

  // Step3
  const [finalText, setFinalText] = useState("");

  // 画像URL管理
  useEffect(() => {
    if (!file) {
      setImageURL("");
      return;
    }
    const url = URL.createObjectURL(file);
    setImageURL(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Step0 -> Step1 初期化 & 初回アシスタント応答
  const startStep1 = async () => {
    if (!file) return;
    setLoading(1);
    try {
      setS1Confirming(false);
      setS1Summary("");
      setNote1("");
      const kickoff = buildStep1KickoffMessages(freeText);
      setS1Msgs(kickoff);

      const out = await sendChat({ messages: kickoff, imageFile: file });
      setS1Msgs([...kickoff, { role: "assistant", content: out }]);
    } finally {
      setLoading(false);
    }
  };

  // Step1 チャット送信
  const sendStep1Chat = async () => {
    if (!file) return;
    const text = s1Input.trim();
    if (!text) return;

    const nextMsgs: ChatMessage[] = [...s1Msgs, { role: "user", content: text }];
    setS1Msgs(nextMsgs);
    setS1Input("");

    setLoading(1);
    try {
      const out = await sendChat({ messages: nextMsgs, imageFile: file });
      setS1Msgs([...nextMsgs, { role: "assistant", content: out }]);
    } finally {
      setLoading(false);
    }
  };

  // Step1 まとめ生成（暫定まとめ→ユーザ編集→確定）
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

  // Step2 カテゴリ候補生成
  const runStep2Categories = async () => {
    if (!file) return;
    setLoading(2);
    setChosenCategory(null);
    setDrillText(null);
    try {
      const out = await sendChat({ messages: buildStep2CategoryMessages(s1Summary), imageFile: file });
      setCategoriesRaw(out);
    } finally {
      setLoading(false);
    }
  };

  // Step2 深掘り
  const runStep2Drill = async (cat: string) => {
    if (!file) return;
    setLoading(2);
    setChosenCategory(cat);
    try {
      const out = await sendChat({
        messages: buildStep2DrillMessages(cat, s1Summary, freeText, note1),
        imageFile: file,
      });
      setDrillText(out);
    } finally {
      setLoading(false);
    }
  };

  // Step2 に入ったら候補自動生成（s1Summaryがあるときだけ）
  useEffect(() => {
    if (step === 2 && s1Summary.trim() && categories.length === 0 && !loading) {
      runStep2Categories();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Step3 生成
  const runStep3 = async () => {
    if (!file) return;
    setLoading(3);
    try {
      const out = await sendChat({
        messages: buildStep3Messages(s1Summary, chosenCategory, drillText, note2),
        imageFile: file,
      });
      setFinalText(out);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full h-screen overflow-hidden grid grid-cols-1 md:grid-cols-2 bg-background max-w-[1600px] mx-auto px-2 md:px-4">
      {/* 左：画像（固定サイズ） */}
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

      {/* 右：ページ切替 */}
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
                    <div className="space-y-2">
                      <label className="text-sm text-muted-foreground">自由記述</label>
                      <Textarea
                        value={freeText}
                        onChange={(e) => setFreeText(e.target.value)}
                        placeholder="例：夢の中みたい / ざわざわする など"
                        className="h-40"
                      />
                    </div>

                    <div className="flex gap-2">
                      <Button
                        onClick={async () => {
                          setStep(1);
                          await startStep1();
                        }}
                        disabled={!file || !freeText.trim()}
                      >
                        次へ（対話を開始）
                      </Button>
                    </div>

                    <div className="text-xs text-muted-foreground">
                      ※ Step1 は「評価」ではなく、あなたの印象の根拠を一緒に言葉にする対話です。
                    </div>
                  </CardContent>
                </Page>
              )}

              {/* Step1（完全チャット） */}
              {step === 1 && (
                <Page key="p1">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Wand2 className="h-5 w-5" /> Step 1：印象の根拠を対話で明確にする
                    </CardTitle>
                  </CardHeader>

                  <CardContent className="flex flex-col h-full gap-3">
                    {/* チャットログ */}
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

                    {/* 入力（まとめ確認中は隠す） */}
                    {!s1Confirming && (
                      <div className="flex gap-2">
                        <Input
                          value={s1Input}
                          onChange={(e) => setS1Input(e.target.value)}
                          placeholder="思ったことをそのまま書いてOK"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              void sendStep1Chat();
                            }
                          }}
                        />
                        <Button onClick={sendStep1Chat} disabled={!s1Input.trim() || loading === 1}>
                          送信
                        </Button>
                        <Button
                          variant="outline"
                          onClick={makeStep1Summary}
                          disabled={s1Msgs.filter((m) => m.role !== "system").length < 3 || loading === 1}
                        >
                          まとめへ
                        </Button>
                      </div>
                    )}

                    {/* 暫定まとめ（ユーザが編集して確定） */}
                    {s1Confirming && (
                      <div className="space-y-2">
                        <div className="text-sm text-muted-foreground">暫定まとめ（編集してOK）</div>
                        <Textarea value={s1Summary} onChange={(e) => setS1Summary(e.target.value)} className="h-32" />
                        <div className="flex gap-2">
                          <Button variant="secondary" onClick={() => setS1Confirming(false)}>
                            もう少し対話する
                          </Button>
                          <Button
                            onClick={() => setStep(2)}
                            disabled={!s1Summary.trim()}
                          >
                            このまとめで次へ
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* ユーザメモ */}
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

              {/* Step2 */}
              {step === 2 && (
                <Page key="p2">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Lightbulb className="h-5 w-5" /> Step 2：別視点の選択
                    </CardTitle>
                  </CardHeader>

                  <CardContent className="space-y-3">
                    {!s1Summary.trim() && (
                      <div className="text-sm text-destructive">
                        Step1 の「まとめ」が未確定です。Step1 に戻って「まとめへ」を押してください。
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button onClick={runStep2Categories} disabled={loading === 2 || !s1Summary.trim()}>
                        {loading === 2 ? <Loader2 className="h-4 w-4 animate-spin" /> : "カテゴリ候補を生成"}
                      </Button>
                      <Button variant="secondary" onClick={() => setStep(1)}>
                        戻る
                      </Button>
                      <Button onClick={() => setStep(3)} disabled={!chosenCategory || !drillText}>
                        次へ
                      </Button>
                    </div>

                    {categories.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-2">
                        {categories.map((c) => (
                          <Button
                            key={c}
                            size="sm"
                            variant={chosenCategory === c ? "default" : "outline"}
                            onClick={() => runStep2Drill(c)}
                          >
                            {c}
                          </Button>
                        ))}
                      </div>
                    )}

                    {drillText && <pre className="whitespace-pre-wrap text-sm bg-muted/40 p-3 rounded-lg">{drillText}</pre>}

                    <label className="text-sm text-muted-foreground">あなたのメモ（任意）</label>
                    <Textarea value={note2} onChange={(e) => setNote2(e.target.value)} className="h-20" />
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
                      <Button onClick={runStep3} disabled={loading === 3 || !s1Summary.trim()}>
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

// ===== 右ペイン：ページラッパ =====
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

// ===== ヘッダー =====
function Header({ step, onJump }: { step: 0 | 1 | 2 | 3; onJump: (s: 0 | 1 | 2 | 3) => void }) {
  if (step === 0) return null;

  const items = [
    { n: 0 as const, label: "初期入力" },
    { n: 1 as const, label: "根拠対話" },
    { n: 2 as const, label: "視点拡張" },
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
