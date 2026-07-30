"use client";

import { useState } from "react";
import { Bot, Code2, ImagePlus, LoaderCircle, MessageSquareText, Send, Sparkles, Trash2, User, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RuntimeImage } from "@/components/runtime-image";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { httpRequest } from "@/lib/request";

import { pretty, type ChatCompletionResponse, type ChatContentPart, type ChatMessage } from "./types";

type SelectedImage = {
  id: string;
  name: string;
  size: number;
  url: string;
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function readImage(file: File): Promise<SelectedImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error(`${file.name} 不是图片文件`));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`${file.name} 超过 10MB`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      if (!url.startsWith("data:image/")) {
        reject(new Error(`${file.name} 读取失败`));
        return;
      }
      resolve({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(16).slice(2)}`,
        name: file.name,
        size: file.size,
        url,
      });
    };
    reader.onerror = () => reject(reader.error || new Error(`${file.name} 读取失败`));
    reader.readAsDataURL(file);
  });
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function messageImages(message: ChatMessage): string[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content
    .filter((part): part is { type: "image_url"; image_url: { url: string } } => part.type === "image_url")
    .map((part) => part.image_url.url);
}

export function ChatPanel() {
  const [model, setModel] = useState("auto");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [input, setInput] = useState("你好，先记住我的项目叫 chatgpt2api。");
  const [selectedImages, setSelectedImages] = useState<SelectedImage[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [raw, setRaw] = useState<ChatCompletionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleImagesChange = async (files: FileList | null) => {
    if (!files?.length) return;
    setError("");
    try {
      const images = await Promise.all(Array.from(files).map(readImage));
      setSelectedImages((current) => [...current, ...images].slice(0, 4));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const sendChat = async () => {
    const text = input.trim();
    if (!text && !selectedImages.length) return;
    const content: string | ChatContentPart[] = selectedImages.length
      ? [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...selectedImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.url } })),
        ]
      : text;
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setInput("");
    setSelectedImages([]);
    setLoading(true);
    setError("");
    try {
      const body = {
        model: model.trim() || "auto",
        messages: nextMessages,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      };
      const result = await httpRequest<ChatCompletionResponse>("/v1/chat/completions", { method: "POST", body });
      setRaw(result);
      setMessages([...nextMessages, { role: "assistant", content: String(result.choices?.[0]?.message?.content || "") }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setSelectedImages([]);
    setRaw(null);
    setError("");
  };

  return (
    <div className="grid min-h-0 gap-4 xl:grid-cols-[390px_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-white/85 shadow-sm dark:border-white/10 dark:bg-stone-950/55">
        <header className="flex items-start gap-3 border-b border-stone-200/70 px-5 py-4 dark:border-white/10">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
            <Sparkles className="size-4" />
          </span>
          <div>
            <h2 className="font-semibold text-stone-950 dark:text-stone-50">构建测试请求</h2>
            <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">验证模型选择、思考强度和多模态输入。</p>
          </div>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
            <div className="space-y-2">
              <Label htmlFor="chat-model">Model</Label>
              <Input id="chat-model" value={model} onChange={(event) => setModel(event.target.value)} className="h-10 rounded-xl border-stone-200 bg-white shadow-none dark:border-white/10 dark:bg-stone-950/50" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-reasoning-effort">思考强度</Label>
              <Select value={reasoningEffort || "default"} onValueChange={(value) => setReasoningEffort(value === "default" ? "" : value)}>
                <SelectTrigger id="chat-reasoning-effort" className="h-10 rounded-xl border-stone-200 bg-white shadow-none dark:border-white/10 dark:bg-stone-950/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">默认</SelectItem>
                  <SelectItem value="low">低</SelectItem>
                  <SelectItem value="medium">中</SelectItem>
                  <SelectItem value="high">高</SelectItem>
                  <SelectItem value="xhigh">超高</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="chat-input">对话内容</Label>
            <Textarea id="chat-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="输入要发送给模型的消息" className="min-h-36 rounded-xl border-stone-200 bg-white shadow-none dark:border-white/10 dark:bg-stone-950/50" />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="chat-images">参考图片</Label>
              <span className="text-[11px] text-stone-400">最多 4 张 · 单张 10MB</span>
            </div>
            <label htmlFor="chat-images" className="flex min-h-16 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 bg-stone-50/70 px-3 py-3 text-sm text-stone-600 transition hover:border-violet-300 hover:bg-violet-50/60 hover:text-violet-700 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-300 dark:hover:border-violet-400/30 dark:hover:bg-violet-400/8">
              <ImagePlus className="size-4" />
              点击选择图片
            </label>
            <input id="chat-images" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" onChange={(event) => {
              void handleImagesChange(event.target.files);
              event.currentTarget.value = "";
            }} />
            {selectedImages.length ? (
              <div className="grid grid-cols-2 gap-2">
                {selectedImages.map((image) => (
                  <div key={image.id} className="group relative overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-white/10 dark:bg-white/[0.04]">
                    <RuntimeImage src={image.url} alt={image.name} className="aspect-square w-full object-cover" />
                    <button type="button" aria-label={`移除 ${image.name}`} onClick={() => setSelectedImages((current) => current.filter((item) => item.id !== image.id))} className="absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-lg bg-white/90 text-stone-700 shadow-sm transition hover:bg-white dark:bg-stone-950/90 dark:text-stone-100">
                      <X className="size-4" />
                    </button>
                    <div className="absolute inset-x-0 bottom-0 truncate bg-white/90 px-2 py-1 text-xs text-stone-600 dark:bg-stone-950/90 dark:text-stone-300">{image.name}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" className="h-10 rounded-xl sm:w-auto" onClick={clearChat}>
              <Trash2 className="size-4" />
              清空上下文
            </Button>
            <Button className="h-10 flex-1 rounded-xl bg-stone-950 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-950 dark:hover:bg-stone-200" onClick={() => void sendChat()} disabled={loading || (!input.trim() && !selectedImages.length)}>
              {loading ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
              {loading ? "正在发送" : "发送测试请求"}
            </Button>
          </div>
          {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50/60 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-300">{error}</div> : null}
          <details className="group rounded-xl border border-stone-200 bg-stone-50/70 dark:border-white/10 dark:bg-white/[0.03]">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-stone-700 dark:text-stone-200">
              <Code2 className="size-4 text-stone-400" />
              查看原始响应
              <span className="ml-auto text-xs font-normal text-stone-400">{raw ? "已返回" : "暂无数据"}</span>
            </summary>
            <div className="border-t border-stone-200 p-3 dark:border-white/10">
              <Textarea value={raw ? pretty(raw) : "{\n  \"messages\": []\n}"} readOnly className="min-h-64 resize-none rounded-xl border-stone-200 bg-white p-4 font-mono text-xs leading-5 text-stone-600 shadow-none dark:border-white/10 dark:bg-stone-950/50 dark:text-stone-300" />
            </div>
          </details>
        </div>
      </section>
      <section className="flex min-h-[38rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-white/85 shadow-sm dark:border-white/10 dark:bg-stone-950/55">
        <header className="flex items-center justify-between gap-3 border-b border-stone-200/70 px-5 py-4 dark:border-white/10">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-stone-100 text-stone-700 dark:bg-white/8 dark:text-stone-200">
              <MessageSquareText className="size-4" />
            </span>
            <div>
              <h2 className="font-semibold text-stone-950 dark:text-stone-50">对话结果</h2>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">显示当前测试上下文中的消息</p>
            </div>
          </div>
          <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-400">
            {messages.length} 条
          </span>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-auto bg-stone-50/45 p-5 sm:p-6 dark:bg-black/10">
          {messages.length ? messages.map((message, index) => {
            const isUser = message.role === "user";
            return (
              <div key={`${message.role}-${index}`} className={`flex items-start gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
                <span className={`grid size-8 shrink-0 place-items-center rounded-full ${isUser ? "bg-stone-950 text-white dark:bg-white dark:text-stone-950" : "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-200"}`}>
                  {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
                </span>
                <div className={`max-w-[85%] space-y-2 ${isUser ? "items-end" : ""}`}>
                  <div className={`text-[11px] font-semibold tracking-wide uppercase text-stone-400 ${isUser ? "text-right" : ""}`}>
                    {isUser ? "You" : "Assistant"}
                  </div>
                  {messageImages(message).length ? (
                    <div className={`flex flex-wrap gap-2 ${isUser ? "justify-end" : ""}`}>
                      {messageImages(message).map((url, imageIndex) => (
                        <RuntimeImage key={`${index}-${imageIndex}`} src={url} alt="" className="h-28 w-28 rounded-xl border border-stone-200 object-cover dark:border-white/10" />
                      ))}
                    </div>
                  ) : null}
                  {messageText(message) ? (
                    <div className={`whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-7 ${isUser ? "rounded-tr-md bg-stone-950 text-white dark:bg-white dark:text-stone-950" : "rounded-tl-md border border-stone-200 bg-white text-stone-700 dark:border-white/10 dark:bg-white/[0.05] dark:text-stone-200"}`}>
                      {messageText(message)}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          }) : (
            <div className="flex h-full min-h-96 flex-col items-center justify-center px-6 text-center">
              <span className="grid size-14 place-items-center rounded-2xl border border-stone-200 bg-white text-stone-400 shadow-sm dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-500">
                <MessageSquareText className="size-6" />
              </span>
              <h3 className="mt-4 text-sm font-semibold text-stone-800 dark:text-stone-200">还没有测试消息</h3>
              <p className="mt-1 max-w-xs text-xs leading-5 text-stone-500 dark:text-stone-400">填写左侧请求并发送后，这里会展示完整的多轮对话。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
