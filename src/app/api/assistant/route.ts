import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { addAssistantMessage, listAssistantMessages } from "@/lib/db";
import { replyToAssistantMessage } from "@/lib/assistantChat";
import type { AssistantMessage } from "@/lib/types";

export const dynamic = "force-dynamic";

// The floating robot assistant's "how do I use this site" chat (opened by
// clicking the robot — see src/components/RobotAssistant.tsx). GET returns
// the signed-in user's recent history; POST saves their message and gets a
// reply from src/lib/assistantChat.ts. Deliberately a separate log/route
// from /api/journal (the personal diary chat) — different purpose, different
// system prompt, no keyword extraction here.

export async function GET() {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const messages = listAssistantMessages(user.userId, 100);
  return NextResponse.json({ messages });
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 });

  const userMessage: AssistantMessage = {
    id: crypto.randomUUID(),
    userId: user.userId,
    role: "user",
    content: message,
    createdAt: new Date().toISOString(),
  };
  addAssistantMessage(user.userId, userMessage);

  // Exclude the message we just added, and cap the history sent to the AI.
  const priorMessages = listAssistantMessages(user.userId, 21).slice(0, -1);
  const history = priorMessages.map((m) => ({ role: m.role, content: m.content }));

  try {
    const reply = await replyToAssistantMessage({ history, message });

    const aiMessage: AssistantMessage = {
      id: crypto.randomUUID(),
      userId: user.userId,
      role: "ai",
      content: reply,
      createdAt: new Date().toISOString(),
    };
    addAssistantMessage(user.userId, aiMessage);

    return NextResponse.json({ message: aiMessage });
  } catch (err) {
    console.error("[assistant] AI reply failed:", err);
    return NextResponse.json(
      { error: "Failed to get a reply — try again in a moment." },
      { status: 500 }
    );
  }
}
