import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { addJournalEntry, listJournalEntries, getUserById, updateUser } from "@/lib/db";
import { replyToJournalEntry, mergeJournalKeywords } from "@/lib/journal";
import type { JournalEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

// Per-user daily journal chat ("write like a diary, AI replies like a
// friend") — opened from the Storyboard canvas toolbar (see
// src/components/StoryboardCanvas.tsx). GET returns the signed-in user's
// recent history; POST saves their entry, gets a short warm AI reply (see
// src/lib/journal.ts), and folds any extracted personality/habit/interest
// keywords into User.journalKeywords for the admin User Data graph.

export async function GET() {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const entries = listJournalEntries(user.userId, 100);
  return NextResponse.json({ entries });
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 });

  const userEntry: JournalEntry = {
    id: crypto.randomUUID(),
    userId: user.userId,
    role: "user",
    content: message,
    createdAt: new Date().toISOString(),
  };
  addJournalEntry(user.userId, userEntry);

  // Exclude the entry we just added, and cap the history sent to the AI.
  const priorEntries = listJournalEntries(user.userId, 21).slice(0, -1);
  const history = priorEntries.map((e) => ({ role: e.role, content: e.content }));

  try {
    const { reply, keywords } = await replyToJournalEntry({ history, newEntry: message });

    const aiEntry: JournalEntry = {
      id: crypto.randomUUID(),
      userId: user.userId,
      role: "ai",
      content: reply,
      createdAt: new Date().toISOString(),
    };
    addJournalEntry(user.userId, aiEntry);

    if (keywords.length > 0) {
      const fullUser = getUserById(user.userId);
      const merged = mergeJournalKeywords(fullUser?.journalKeywords, keywords);
      updateUser(user.userId, { journalKeywords: merged });
    }

    return NextResponse.json({ entry: aiEntry });
  } catch (err) {
    console.error("[journal] AI reply failed:", err);
    return NextResponse.json(
      { error: "Failed to get a reply — your entry was saved, try again in a moment." },
      { status: 500 }
    );
  }
}
