const axios = require("axios");
const vm = require("vm");

const {
  SUPPORTED_LANGUAGES,
  buildValidationContract,
  compareOutputs,
} = require("./problems");

const JUDGE0_URL = process.env.JUDGE0_URL || "";
const JUDGE0_KEY = process.env.JUDGE0_KEY || "";

const languageMap = {
  javascript: 63,
  python: 71,
  java: 62,
};

function normalizeLanguage(language) {
  const normalized = String(language || "")
    .trim()
    .toLowerCase();
  if (!SUPPORTED_LANGUAGES.includes(normalized)) {
    return null;
  }

  return normalized;
}

function mapJudgeStatusToResult(judgeResult, language) {
  const statusId = Number(judgeResult?.status?.id || 0);
  const statusText = String(judgeResult?.status?.description || "Unknown");

  if (statusId === 3) {
    return {
      verdict: "accepted",
      status: "Accepted",
      language,
      stdout: String(judgeResult?.stdout || ""),
      stderr: "",
      runtime: judgeResult?.time ?? null,
      memory: judgeResult?.memory ?? null,
      engine: "judge0",
    };
  }

  const compileErrorStatuses = new Set([6, 14]);
  const runtimeErrorStatuses = new Set([5, 7, 8, 9, 10, 11, 12, 13]);

  if (compileErrorStatuses.has(statusId)) {
    return {
      verdict: "compile-error",
      status: statusText,
      language,
      stdout: String(judgeResult?.stdout || ""),
      stderr: String(
        judgeResult?.compile_output ||
          judgeResult?.stderr ||
          "Compilation failed",
      ),
      runtime: judgeResult?.time ?? null,
      memory: judgeResult?.memory ?? null,
      engine: "judge0",
    };
  }

  if (runtimeErrorStatuses.has(statusId)) {
    return {
      verdict: "runtime-error",
      status: statusText,
      language,
      stdout: String(judgeResult?.stdout || ""),
      stderr: String(judgeResult?.stderr || "Runtime failed"),
      runtime: judgeResult?.time ?? null,
      memory: judgeResult?.memory ?? null,
      engine: "judge0",
    };
  }

  return {
    verdict: "execution-error",
    status: statusText,
    language,
    stdout: String(judgeResult?.stdout || ""),
    stderr: String(
      judgeResult?.stderr || judgeResult?.compile_output || "Execution failed",
    ),
    runtime: judgeResult?.time ?? null,
    memory: judgeResult?.memory ?? null,
    engine: "judge0",
  };
}

function normalizeExecutionResult(result) {
  const verdict = String(result?.verdict || "execution-error");
  return {
    verdict,
    passed: verdict === "accepted",
    status: String(result?.status || "Execution Error"),
    stdout: String(result?.stdout || ""),
    stderr: String(result?.stderr || ""),
    runtime: result?.runtime ?? null,
    memory: result?.memory ?? null,
    language: String(result?.language || ""),
    engine: String(result?.engine || "unknown"),
  };
}

function toOutputText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null || typeof value === "undefined") {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function runLocalJavaScriptCase(sourceCode, input) {
  const logs = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console: {
      log: (...args) => {
        logs.push(args.map((item) => toOutputText(item)).join(" "));
      },
    },
  };

  vm.createContext(sandbox);

  try {
    vm.runInContext(String(sourceCode || ""), sandbox, {
      timeout: 1_000,
    });
  } catch (error) {
    const isCompileError = error instanceof SyntaxError;
    return {
      verdict: isCompileError ? "compile-error" : "runtime-error",
      status: isCompileError ? "Compilation Error" : "Runtime Error",
      stdout: "",
      stderr: String(error?.message || "Failed to compile source"),
      runtime: null,
      memory: null,
    };
  }

  const exportedSolve =
    typeof sandbox.solve === "function"
      ? sandbox.solve
      : typeof sandbox.module.exports === "function"
        ? sandbox.module.exports
        : typeof sandbox.module.exports?.solve === "function"
          ? sandbox.module.exports.solve
          : typeof sandbox.exports?.solve === "function"
            ? sandbox.exports.solve
            : null;

  if (typeof exportedSolve !== "function") {
    return {
      verdict: "compile-error",
      status: "Compilation Error",
      stdout: "",
      stderr: "Expected a solve(input) function export",
      runtime: null,
      memory: null,
    };
  }

  const startedAt = process.hrtime.bigint();
  try {
    const outputValue = exportedSolve(String(input ?? ""));
    if (outputValue && typeof outputValue.then === "function") {
      return {
        verdict: "runtime-error",
        status: "Runtime Error",
        stdout: "",
        stderr: "Async solve(input) is not supported in local fallback mode",
        runtime: null,
        memory: null,
      };
    }

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const stdout =
      logs.length > 0 ? logs.join("\n") : toOutputText(outputValue);

    return {
      verdict: "accepted",
      status: "Accepted",
      stdout,
      stderr: "",
      runtime: Number.isFinite(elapsedMs) ? elapsedMs.toFixed(3) : null,
      memory: null,
    };
  } catch (error) {
    return {
      verdict: "runtime-error",
      status: "Runtime Error",
      stdout: logs.join("\n"),
      stderr: String(error?.message || "Runtime failed"),
      runtime: null,
      memory: null,
    };
  }
}

async function runJudge0Validation({ sourceCode, language, contract }) {
  if (!JUDGE0_URL) {
    return null;
  }

  if (contract.mode !== "test-cases" || contract.testCases.length === 0) {
    return null;
  }

  for (const testCase of contract.testCases) {
    const judgeResult = await runWithJudge0({
      sourceCode,
      language,
      stdin: testCase.input,
    });

    const statusResult = mapJudgeStatusToResult(judgeResult, language);
    if (statusResult.verdict !== "accepted") {
      return statusResult;
    }

    const matched = compareOutputs(
      statusResult.stdout,
      testCase.expectedOutput,
      contract.comparator,
    );

    if (!matched) {
      return {
        verdict: "wrong-answer",
        status: "Wrong Answer",
        language,
        stdout: statusResult.stdout,
        stderr: "Output did not match expected result",
        runtime: statusResult.runtime,
        memory: statusResult.memory,
        engine: "judge0",
      };
    }
  }

  return {
    verdict: "accepted",
    status: "Accepted",
    language,
    stdout: "",
    stderr: "",
    runtime: null,
    memory: null,
    engine: "judge0",
  };
}

function runLegacyValidation({ sourceCode, language, contract }) {
  const passed = Boolean(contract.validateCode(String(sourceCode || "")));
  return {
    verdict: passed ? "accepted" : "wrong-answer",
    status: passed ? "Accepted" : "Wrong Answer",
    language,
    stdout: "",
    stderr: "",
    runtime: null,
    memory: null,
    engine: "legacy-validator",
  };
}

function runLocalValidation({ sourceCode, language, contract }) {
  if (contract.mode === "legacy-validator") {
    return runLegacyValidation({ sourceCode, language, contract });
  }

  if (contract.mode !== "test-cases" || contract.testCases.length === 0) {
    return {
      verdict: "execution-error",
      status: "Execution Error",
      language,
      stdout: "",
      stderr: "Problem is missing validation test cases",
      runtime: null,
      memory: null,
      engine: "local-validator",
    };
  }

  if (language !== "javascript") {
    return {
      verdict: "unsupported-language",
      status: "Unsupported Language",
      language,
      stdout: "",
      stderr:
        "Local fallback supports JavaScript only. Configure Judge0 for Python/Java execution.",
      runtime: null,
      memory: null,
      engine: "local-validator",
    };
  }

  for (const testCase of contract.testCases) {
    const localResult = runLocalJavaScriptCase(sourceCode, testCase.input);
    if (localResult.verdict !== "accepted") {
      return {
        ...localResult,
        language,
        engine: "local-js",
      };
    }

    const matched = compareOutputs(
      localResult.stdout,
      testCase.expectedOutput,
      contract.comparator,
    );

    if (!matched) {
      return {
        verdict: "wrong-answer",
        status: "Wrong Answer",
        language,
        stdout: localResult.stdout,
        stderr: "Output did not match expected result",
        runtime: localResult.runtime,
        memory: localResult.memory,
        engine: "local-js",
      };
    }
  }

  return {
    verdict: "accepted",
    status: "Accepted",
    language,
    stdout: "",
    stderr: "",
    runtime: null,
    memory: null,
    engine: "local-js",
  };
}

async function runWithJudge0({
  sourceCode,
  language = "javascript",
  stdin = "",
}) {
  if (!JUDGE0_URL) {
    return null;
  }

  const languageId = languageMap[language];
  if (!languageId) {
    return null;
  }
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
  const normalizedLanguage = normalizeLanguage(language);
  if (!normalizedLanguage) {
    return normalizeExecutionResult({
      verdict: "invalid-language",
      status: "Invalid Language",
      language,
      stdout: "",
      stderr: `Unsupported language '${language}'. Allowed values: ${SUPPORTED_LANGUAGES.join(
        ", ",
      )}`,
      runtime: null,
      memory: null,
      engine: "precheck",
    });
  }

  const sourceCode = String(code || "");
  const contract = buildValidationContract(room?.problem);

  try {
    const judgeResult = await runJudge0Validation({
      sourceCode,
      language: normalizedLanguage,
      contract,
    });

    if (judgeResult) {
      return normalizeExecutionResult(judgeResult);
    }
  } catch (_error) {
    // Fallback intentionally preserves battle continuity when external judge fails.
  }

  return normalizeExecutionResult(
    runLocalValidation({
      sourceCode,
      language: normalizedLanguage,
      contract,
    }),
  );
}

module.exports = {
  executeSubmission,
};
