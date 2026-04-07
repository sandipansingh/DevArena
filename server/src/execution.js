const axios = require("axios");

const JUDGE0_URL = process.env.JUDGE0_URL || "";
const JUDGE0_KEY = process.env.JUDGE0_KEY || "";

const languageMap = {
  javascript: 63,
  python: 71,
  java: 62,
};

async function runWithJudge0({ sourceCode, language = "javascript", stdin = "" }) {
  if (!JUDGE0_URL) {
    return null;
  }

  const languageId = languageMap[language] || 63;
  const headers = {
    "Content-Type": "application/json",
  };

  if (JUDGE0_KEY) {
    headers["X-RapidAPI-Key"] = JUDGE0_KEY;
  }

  const createResponse = await axios.post(
    `${JUDGE0_URL}/submissions?base64_encoded=false&wait=false`,
    {
      source_code: sourceCode,
      language_id: languageId,
      stdin,
    },
    { headers, timeout: 10_000 },
  );

  const token = createResponse.data?.token;
  if (!token) {
    throw new Error("Judge0 did not return a submission token");
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const resultResponse = await axios.get(
      `${JUDGE0_URL}/submissions/${token}?base64_encoded=false`,
      { headers, timeout: 10_000 },
    );

    const statusId = resultResponse.data?.status?.id;
    if (statusId && statusId >= 3) {
      return resultResponse.data;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Judge0 timed out while waiting for execution result");
}

async function executeSubmission({ code, language = "javascript", room }) {
  try {
    const judgeResult = await runWithJudge0({
      sourceCode: String(code || ""),
      language,
      stdin: room.problem.sampleInput,
    });

    if (judgeResult) {
      const accepted = judgeResult.status?.id === 3;
      return {
        passed: accepted,
        engine: "judge0",
        status: judgeResult.status?.description || "Unknown",
        stdout: judgeResult.stdout || "",
        stderr: judgeResult.stderr || judgeResult.compile_output || "",
      };
    }
  } catch (_error) {
    // Fallback intentionally preserves battle continuity when external judge fails.
  }

  const passed = room.problem.validator(String(code || ""));
  return {
    passed,
    engine: "local-validator",
    status: passed ? "Accepted" : "Wrong Answer",
    stdout: "",
    stderr: "",
  };
}

module.exports = {
  executeSubmission,
};
