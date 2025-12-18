"use client";
import ViewerAssistant1 from "../components/ViewerAssistant1";

type ChatMessage = { role:"system"|"user"|"assistant"; content:string };

export default function Page(){
  async function sendChat(messages: ChatMessage[]){
    const r = await fetch("/api/chat",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({messages})
    });
    const j = await r.json();
    return j.text as string;
  }

  return <ViewerAssistant1 sendChat={sendChat} />;
}
