const axios = require("axios");

const AI_ENABLED = String(process.env.AI_ENABLED || "false").toLowerCase() === "true";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

async function callOpenAI(systemPrompt, userPrompt) {
  if (!AI_ENABLED || !OPENAI_API_KEY) {
    return null;
  }

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 12_000,
    },
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch (_error) {
    return null;
  }
}

async function generateProblemForMatch({ difficulty, players }) {
  const system =
    "You are a competitive programming problem generator. Return strict JSON with keys: title, description, constraints (array), sampleInput, sampleOutput, difficulty.";
  const user = `Create one ${difficulty} level coding problem for a 1v1 contest. Players: ${players
    .map((p) => `${p.username}(${p.rating || 1200})`)
    .join(", ")}. Keep it solvable in <=25 minutes. Return concise but complete statement.`;

  const data = await callOpenAI(system, user);
  if (!data?.title || !data?.description) {
    return null;
  }

  return {
    id: `ai-${Date.now()}`,
    title: String(data.title).slice(0, 120),
    difficulty,
    description: String(data.description),
    constraints: Array.isArray(data.constraints) ? data.constraints.map(String).slice(0, 8) : [],
    sampleInput: String(data.sampleInput || ""),
    sampleOutput: String(data.sampleOutput || ""),
    // AI-generated problems fall back to status-based validation when Judge0 is absent.
    validator: (code) => String(code || "").trim().length > 40,
    source: "ai",
  };
}

async function judgeBattleAndCoach({ problem, players, submissions, winnerId }) {
  const system =
    "You are an impartial coding contest judge and coach. Return strict JSON with keys: summary, winnerReason, perPlayer (array of {userId, strengths, weaknesses, suggestions}), qualityScores (object keyed by userId with 0-100).";

  const user = JSON.stringify(
    {
      task: "Compare both contestant submissions and provide fair coaching.",
      problem: {
        title: problem.title,
        description: problem.description,
      },
      players,
      submissions,
      winnerId,
    },
    null,
    2,
  );

  const data = await callOpenAI(system, user);
  if (!data) {
    return null;
  }

  return {
    summary: String(data.summary || "No AI summary available."),
    winnerReason: String(data.winnerReason || "Winner chosen by execution outcome."),
    qualityScores: typeof data.qualityScores === "object" && data.qualityScores ? data.qualityScores : {},
    perPlayer: Array.isArray(data.perPlayer)
      ? data.perPlayer.map((entry) => ({
          userId: String(entry.userId || ""),
          strengths: String(entry.strengths || ""),
          weaknesses: String(entry.weaknesses || ""),
          suggestions: String(entry.suggestions || ""),
        }))
      : [],
  };
}

module.exports = {
  AI_ENABLED,
  generateProblemForMatch,
  judgeBattleAndCoach,
};
