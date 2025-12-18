"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Loader2,
  Upload,
  Wand2,
  Lightbulb,
  FileText,
  Image as ImageIcon,
  X,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
} from "lucide-react";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type SendChatFn = (messages: ChatMessage[]) => Promise<string>;

// ===== ダミー（/api/chat を渡さないとき） =====
async function dummySendChat(messages: ChatMessage[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  await new Promise((r) => setTimeout(r, 300));
  return `【DUMMY】\n${lastUser.slice(0, 300)}${lastUser.length > 300 ? "…" : ""}`;
}

// Step1: 「要素＋効果/物語」フォーマットで短く（鑑賞者のトーンを尊重）
function buildStep1Messages(desc: string, imps: string[], free: string): ChatMessage[] {
  const SYSTEM =
    "あなたは美術鑑賞を支援する対話アシスタントです。鑑賞者の語彙やトーンを尊重し、言い換えは控えめにしてください。ユーザの印象語に対応しそうな視覚的要素と、それが絵の印象・物語に与える効果を示唆的に返してください。";
  const INSTRUCTIONS =
    "出力は3点。各点は2行で、1行目:『視覚的要素: 〜』、2行目:『効果/物語: 〜』。断定を避け、外部知識は持ち込まない。簡潔に。";
  const user = `画像概略: ${desc || "（なし）"}
印象語: ${imps.length ? imps.join(", ") : "(未選択)"}
自由記述: ${free.trim() || "(なし)"}
${INSTRUCTIONS}`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// Step1’ 再生成（ユーザの評価を反映）
function buildStep1RegenerateMessages(
  desc: string,
  imps: string[],
  free: string,
  lastStep1: string,
  feedback: Array<{ ok: boolean; note?: string }>
): ChatMessage[] {
  const fbText = feedback
    .map((f, i) => `${i + 1}. ${f.ok ? "共感" : "違和感"}${f.note ? `／補足: ${f.note}` : ""}`)
    .join("\n");
  const SYSTEM =
    "あなたは美術鑑賞を支援する対話アシスタントです。以下の鑑賞者フィードバックを反映し、より本人の感じ方に沿う形で修正提案を行ってください。";
  const INSTRUCTIONS =
    "出力は3点。各点は『視覚的要素: 〜』『効果/物語: 〜』の2行。冗長さを避け、重複観点は避ける。";
  const user = `前回の出力:\n${lastStep1}\n---\n鑑賞者フィードバック:\n${fbText}\n---\n画像概略: ${desc}
印象語: ${imps.join(", ")}
自由記述: ${free}
${INSTRUCTIONS}`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// Step2: カテゴリ候補（短語）を返させる
function buildStep2CategoryMessages(step1: string, desc: string): ChatMessage[] {
  const SYSTEM =
    "あなたは鑑賞者の視点を拡張する支援者です。前段の示唆と重ならない『別の観点カテゴリ』候補を3〜5個、短い名詞だけで出してください。";
  const INSTRUCTIONS =
    "出力は行頭にハイフン不要。各行1語〜2語の短いカテゴリ名のみ（例: 構図 / 光 / 空間 / リズム / スケール / 反復 / 余白 など）。説明文は書かない。";
  const user = `前段の出力:\n${(step1 || "").slice(0, 1200)}\n画像概略: ${desc || "（なし）"}\n${INSTRUCTIONS}`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// Step2’: 選択カテゴリの深掘り（ユーザの気づき＆評価を反映）
function buildStep2DrillMessages(
  category: string,
  step1: string,
  desc: string,
  impressions: string[],
  freeText: string,
  ratings: Array<{ ok: boolean; note?: string }>,
  note1: string
): ChatMessage[] {
  const fb = ratings
    .map((r, i) => `${i + 1}. ${r.ok ? "共感" : "違和感"}${r.note ? `／補足: ${r.note}` : ""}`)
    .join("\n") || "(なし)";
  const SYSTEM =
    "あなたは鑑賞者の視点を深める支援者です。鑑賞者の感じ方と気づきを最優先し、選ばれた観点から、示唆的に2〜3文で掘り下げてください。断定や外部知識は避けます。";
  const user =
    `選択カテゴリ: ${category}\n` +
    `画像概略: ${desc || "（なし）"}\n` +
    `印象語: ${impressions.join(", ") || "(未選択)"}\n` +
    `自由記述: ${freeText || "(なし)"}\n` +
    `Step1の出力（要素＋効果/物語）:\n${(step1 || "").slice(0, 900)}\n` +
    `鑑賞者の評価/補足:\n${fb}\n` +
    `鑑賞者の気づき（メモ）: ${note1 || "(なし)"}\n` +
    `要件: 鑑賞者の語り口に寄り添い、仮説として2〜3文。過度に一般化しない。`;
  return [{ role: "system", content: SYSTEM }, { role: "user", content: user }];
}

// Step3: 統合
function buildStep3Messages(
  imps: string[],
  free: string,
  step1: string,
  chosenCategory: string | null,
  drillText: string | null,
  note1: string,
  note2: string
): ChatMessage[] {
  const SYSTEM =
    "あなたは鑑賞者の言語化を支援するアシスタントです。鑑賞者の主体的な感じ方を核に、示唆的・簡潔な解釈文（2〜3文）を提案してください。";
  const user = `印象語: ${imps.join(", ") || "(未選択)"}\n自由記述: ${free || "(なし)"}\nStep1要約: ${(step1 || "").slice(0, 600)}
選択カテゴリ: ${chosenCategory ?? "(なし)"}\nカテゴリ深掘り: ${drillText ?? "(なし)"}\n本人メモ1: ${note1 || "(なし)"}\n本人メモ2: ${note2 || "(なし)"}
禁止: 作者意図の断定、外部知識、一般論の押し付け。`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// ===== 文字列パース =====
type Step1Item = { element: string; effect: string };

// Step1 の 2行ブロックをパース（フォールバックあり）
function parseStep1(text: string): Step1Item[] {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const items: Step1Item[] = [];
  for (const b of blocks) {
    const el = /視覚的要素\s*:\s*(.+)/.exec(b)?.[1]?.trim();
    const ef = /効果\/物語\s*:\s*(.+)/.exec(b)?.[1]?.trim();
    if (el && ef) items.push({ element: el, effect: ef });
  }
  if (!items.length) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      const s = l.replace(/^-+\s*/, "");
      if (s) items.push({ element: s, effect: "（示唆）" });
    }
  }
  return items.slice(0, 5);
}

// Step2 カテゴリのパースを寛容に
function parseCategories(text: string): string[] {
  const lines = text
    .split("\n")
    .flatMap((l) => l.split(/[、,\/]|・/)) // 区切り文字にも対応
    .map((l) => l.replace(/^-+\s*/, "").trim())
    .filter(Boolean);

  const picked = lines.filter((l) => l.length >= 1 && l.length <= 10);
  const uniq = Array.from(new Set(picked.map((s) => s.replace(/\s+/g, ""))));
  return uniq.slice(0, 8);
}

// ===== メイン =====
export default function ViewerAssistant1({ sendChat = dummySendChat }: { sendChat?: SendChatFn }) {
  // 左
  const [file, setFile] = useState<File | null>(null);
  const [imageURL, setImageURL] = useState("");
  const [imageDesc, setImageDesc] = useState("");

  // 右 入力
  const [impressions, setImpressions] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");

  // 右 状態
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [loading, setLoading] = useState<false | 1 | 2 | 3>(false);

  // Step1
  const [step1Raw, setStep1Raw] = useState("");
  const step1Items = useMemo(() => parseStep1(step1Raw), [step1Raw]);

  // Step1 評価（👍/👎＋補足）
  const [ratings, setRatings] = useState<Array<{ ok: boolean; note?: string }>>([]);
  useEffect(() => {
    setRatings(step1Items.map(() => ({ ok: true }))); // 初期は全部👍
  }, [step1Items.length]);

  // Step2
  const [categoriesRaw, setCategoriesRaw] = useState("");
  const categories = useMemo(() => parseCategories(categoriesRaw), [categoriesRaw]);
  const [chosenCategory, setChosenCategory] = useState<string | null>(null);
  const [drillText, setDrillText] = useState<string | null>(null);
  const [sendMyNotesToDrill, setSendMyNotesToDrill] = useState(true); // ユーザの気づきを深掘りへ送る

  // 個人メモ
  const [note1, setNote1] = useState("");
  const [note2, setNote2] = useState("");

  // Step3
  const [finalText, setFinalText] = useState("");

  // 画像情報
  useEffect(() => {
    if (!file) {
      setImageURL("");
      setImageDesc("");
      return;
    }
    const url = URL.createObjectURL(file);
    setImageURL(url);
    const img = new Image();
    img.onload = () => {
      const aspect = (img.width / img.height).toFixed(2);
      setImageDesc(`解像度: ${img.width}x${img.height}, アスペクト比: ${aspect}`);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Step1 生成（明示遷移で実行）
  const runStep1 = async () => {
    setLoading(1);
    try {
      const out = await sendChat(buildStep1Messages(imageDesc, impressions, freeText));
      setStep1Raw(out);
    } finally {
      setLoading(false);
    }
  };

  // Step1 再生成（評価反映）
  const regenStep1 = async () => {
    setLoading(1);
    try {
      const out = await sendChat(buildStep1RegenerateMessages(imageDesc, impressions, freeText, step1Raw, ratings));
      setStep1Raw(out);
    } finally {
      setLoading(false);
    }
  };

  // Step2 カテゴリ候補生成
  const runStep2Categories = async () => {
    setLoading(2);
    setChosenCategory(null);
    setDrillText(null);
    try {
      const out = await sendChat(buildStep2CategoryMessages(step1Raw, imageDesc));
      setCategoriesRaw(out);
    } finally {
      setLoading(false);
    }
  };

  // Step2 選択カテゴリ深掘り（気づき/評価を反映）
  const runStep2Drill = async (cat: string) => {
    setLoading(2);
    setChosenCategory(cat);
    try {
      const out = await sendChat(
        buildStep2DrillMessages(
          cat,
          step1Raw,
          imageDesc,
          impressions,
          freeText,
          ratings,
          sendMyNotesToDrill ? note1 : ""
        )
      );
      setDrillText(out);
    } finally {
      setLoading(false);
    }
  };

  // Step2 に入ったら、候補が無ければ自動生成（軽快UX）
  useEffect(() => {
    if (step === 2 && categories.length === 0 && !loading) {
      runStep2Categories();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Step3 生成
  const runStep3 = async () => {
    setLoading(3);
    try {
      const out = await sendChat(buildStep3Messages(impressions, freeText, step1Raw, chosenCategory, drillText, note1, note2));
      setFinalText(out);
    } finally {
      setLoading(false);
    }
  };

  // ===== UI（左固定・右はページ切替/スクロール無し） =====
  return (
    <div className="w-full h-screen overflow-hidden grid grid-cols-1 md:grid-cols-2 bg-background max-w-[1600px] mx-auto px-2 md:px-4">

      <div className="relative h-[40vh] md:h-screen md:sticky md:top-0 bg-muted/20 
                flex items-center justify-center p-2 md:p-4">

        <div className="w-full max-w-[520px] h-[340px] md:h-[64vh] rounded-2xl overflow-hidden shadow-sm bg-black/5 flex items-center justify-center relative">
          {/* 枠全体がクリック可能なファイル入力 */}
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
        {imageDesc && <p className="w-full max-w-[520px] text-xs text-muted-foreground">{imageDesc}</p>}
      </div>



      {/* 右：ページ切替 */}
      <div className="h-screen p-4 md:p-6 overflow-hidden flex flex-col">
        <Header step={step} onJump={setStep} />
        <div className="flex-1 flex items-center justify-center overflow-hidden">
          <div className="relative w-full max-w-[720px] h-full md:h-[64vh] overflow-hidden">
            <AnimatePresence mode="popLayout">


            {/* Step 0: 初期入力 */}
            {step === 0 && (
              <Page key="p0">
                <CardHeader className="border-0">
                  <CardTitle className="flex items-center gap-2">
                     <Upload className="h-5 w-5" /> 左の絵を見て思ったことを書いてください
                  </CardTitle>
                </CardHeader>

                <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <label className="text-sm text-muted-foreground">自由記述</label>
                    <Textarea
                      value={freeText}
                      onChange={(e) => setFreeText(e.target.value)}
                      placeholder="例：夢の中みたい / ざわざわする など"
                      className="h-40 w-140"
                    />
                    <div className="flex gap-2 pt-2">
                      <Button
                        onClick={async () => {
                          setStep(1);
                          await runStep1();
                        }}
                        disabled={!file || !(impressions.length > 0 || freeText.trim().length > 0)}
                      >
                        次へ（分析を開始）
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Page>
            )}

            {/* Step 1: 根拠提示（要素＋効果/物語）＋合否UI */}
            {step === 1 && (
              <Page key="p1">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Wand2 className="h-5 w-5" /> Step 1：印象の根拠（要素＋効果/物語）
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {loading === 1 && <LoadingLine label="印象と結びつく視覚的要素を抽出中..." />}

                  {/* 出力のカード化 */}
                  {!loading && step1Items.length > 0 && (
                    <div className="grid gap-2">
                      {step1Items.map((it, idx) => (
                        <div key={idx} className="rounded-lg border p-3 bg-muted/30">
                          <div className="text-sm">
                            <div><strong>視覚的要素:</strong> {it.element}</div>
                            <div><strong>効果/物語:</strong> {it.effect}</div>
                          </div>
                          <div className="flex items-center gap-2 mt-2">
                            <Button
                              size="sm"
                              variant={ratings[idx]?.ok ? "default" : "outline"}
                              onClick={() =>
                                setRatings((rs) => {
                                  const cp = [...rs];
                                  cp[idx] = { ok: true, note: cp[idx]?.note };
                                  return cp;
                                })
                              }
                            >
                              <ThumbsUp className="h-4 w-4 mr-1" />
                              共感
                            </Button>
                            <Button
                              size="sm"
                              variant={!ratings[idx]?.ok ? "default" : "outline"}
                              onClick={() =>
                                setRatings((rs) => {
                                  const cp = [...rs];
                                  cp[idx] = { ok: false, note: cp[idx]?.note };
                                  return cp;
                                })
                              }
                            >
                              <ThumbsDown className="h-4 w-4 mr-1" />
                              違う
                            </Button>
                            {!ratings[idx]?.ok && (
                              <Input
                                placeholder="どの点が違う？（任意）"
                                value={ratings[idx]?.note ?? ""}
                                onChange={(e) =>
                                  setRatings((rs) => {
                                    const cp = [...rs];
                                    cp[idx] = { ok: false, note: e.target.value };
                                    return cp;
                                  })
                                }
                                className="h-8"
                              />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button variant="secondary" onClick={() => setStep(0)}>
                      戻る
                    </Button>
                    <Button onClick={() => setStep(2)} disabled={!step1Items.length}>
                      次へ
                    </Button>
                    <Button variant="outline" onClick={regenStep1} disabled={!step1Items.length || loading === 1}>
                      <RefreshCw className="h-4 w-4 mr-1" />
                      フィードバックを反映して再生成
                    </Button>
                  </div>

                  <label className="text-sm text-muted-foreground">あなたのメモ（任意）</label>
                  <Textarea value={note1} onChange={(e) => setNote1(e.target.value)} className="h-20" />
                </CardContent>
              </Page>
            )}

            {/* Step 2: 別視点（カテゴリ選択→深掘り） */}
            {step === 2 && (
              <Page key="p2">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Lightbulb className="h-5 w-5" /> Step 2：別視点の選択
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Button onClick={runStep2Categories} disabled={loading === 2}>
                      {loading === 2 ? <Loader2 className="h-4 w-4 animate-spin" /> : "カテゴリ候補を生成"}
                    </Button>
                    <Button variant="secondary" onClick={() => setStep(1)}>
                      戻る
                    </Button>
                    <Button onClick={() => setStep(3)} disabled={!chosenCategory || !drillText}>
                      次へ
                    </Button>
                  </div>

                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      id="toggle-notes"
                      type="checkbox"
                      checked={sendMyNotesToDrill}
                      onChange={(e) => setSendMyNotesToDrill(e.target.checked)}
                    />
                    <label htmlFor="toggle-notes">深掘りに「私のメモ（Step1）」を反映する</label>
                  </div>

                  {/* カテゴリボタン群 */}
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

                  {/* 深掘り結果 */}
                  {drillText && (
                    <pre className="whitespace-pre-wrap text-sm bg-muted/40 p-3 rounded-lg">{drillText}</pre>
                  )}

                  <label className="text-sm text-muted-foreground">あなたのメモ（任意）</label>
                  <Textarea value={note2} onChange={(e) => setNote2(e.target.value)} className="h-20" />
                </CardContent>
              </Page>
            )}

            {/* Step 3: 解釈の統合 */}
            {step === 3 && (
              <Page key="p3">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5" /> Step 3：解釈の統合
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Button onClick={runStep3} disabled={loading === 3}>
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

// ===== 右ペイン：ページラッパ（スクロール無しの切替）=====
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

// ===== ヘッダー（段階インジケータ & ジャンプ）=====
// （変更後）Step0 のときは Header を出さない
function Header({ step, onJump }: { step: 0 | 1 | 2 | 3; onJump: (s: 0 | 1 | 2 | 3) => void }) {
  if (step === 0) return null; // ★ これを追加

  const items = [
    { n: 0 as const, label: "初期入力" },
    { n: 1 as const, label: "根拠提示" },
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


// ===== タグ入力（複数＋自由入力）=====
function TagsInput({
  values,
  onChange,
  presets,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  presets: string[];
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const add = (v: string) => {
    const t = v.trim();
    if (!t) return;
    if (values.includes(t)) return;
    onChange([...values, t]);
    setText("");
  };
  const remove = (v: string) => onChange(values.filter((x) => x !== v));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      e.preventDefault();
      add(text);
    } else if (e.key === "Backspace" && !text && values.length) {
      remove(values[values.length - 1]);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 min-h-9 p-2 border rounded-md">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-muted text-sm">
            {v}
            <button aria-label="remove" onClick={() => remove(v)} className="hover:text-destructive">
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="flex-1 outline-none bg-transparent text-sm min-w-[120px]"
          placeholder="Enterで追加 / , でも可"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <Button
            key={p}
            type="button"
            size="sm"
            variant={values.includes(p) ? "default" : "outline"}
            onClick={() => add(p)}
          >
            {p}
          </Button>
        ))}
      </div>
    </div>
  );
}

// ===== ローディング行 =====
function LoadingLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}
