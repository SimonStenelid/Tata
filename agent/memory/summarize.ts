import Anthropic from "@anthropic-ai/sdk"
import { config } from "../config.js"

const client = new Anthropic({ apiKey: config.anthropicApiKey })

const SUMMARY_SYSTEM = `
You write a one-paragraph rolling summary of the user's last conversation
with Tata, a personal-finance assistant. The summary will be saved to
/memories/last-session.md and shown to Tata at the start of the next
conversation, so write it FOR Tata — second person, addressing Tata.

Hard rules:
- One paragraph, 4–8 sentences, plain prose, no headings, no bullets.
- Capture: what the user wanted, what was learned about them or their
  finances, any decisions or commitments made, anything left unfinished.
- Do NOT include numbers that will go stale (current balances, today's
  prices). Do include durable facts (goals, account names, preferences).
- Do NOT restate things already obvious from /memories/profile.md etc.
- If the conversation was trivial ("hi", "thanks"), output exactly:
  "Nothing notable from the previous session."
- Output the paragraph only. No preface, no sign-off.
`.trim()

export async function summarizePriorSession(transcript: string): Promise<string> {
  if (!transcript.trim()) return ""
  const res = await client.messages.create({
    model: config.model,
    max_tokens: 600,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content: transcript }],
  })
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim()
}
