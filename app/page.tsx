"use client";

import ViewerAssistant from "./components/ViewerAssistant";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string; hidden?: boolean };
type SendChatArgs = { messages: ChatMessage[]; imageFile?: File | null };

export default function Page() {
  async function sendChat({ messages, imageFile }: SendChatArgs) {
    const fd = new FormData();
    fd.append(
      "messages",
      JSON.stringify(messages.map(({ role, content }) => ({ role, content })))
    );
    if (imageFile) fd.append("image", imageFile);

    const res = await fetch("/api/chat", { method: "POST", body: fd });
    if (!res.ok) throw new Error("API error");
    const data = await res.json();
    return data.text as string;
  }

  return <ViewerAssistant sendChat={sendChat} />;
}
