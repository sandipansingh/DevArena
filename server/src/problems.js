const SUPPORTED_LANGUAGES = ["javascript", "python", "java"];

function toTrimmedText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function normalizeTestCase(testCase) {
  if (!testCase || typeof testCase !== "object") {
    return null;
  }

  if (typeof testCase.input === "undefined") {
    return null;
  }

  return {
    input: String(testCase.input),
    expectedOutput: String(testCase.expectedOutput ?? ""),
  };
}

function buildValidationContract(problem) {
  if (!problem || typeof problem !== "object") {
    return {
      mode: "none",
      comparator: "trimmed-exact",
      testCases: [],
    };
  }

  const fromValidation = Array.isArray(problem.validation?.testCases)
    ? problem.validation.testCases.map(normalizeTestCase).filter(Boolean)
    : [];

  if (fromValidation.length > 0) {
    return {
      mode: "test-cases",
      comparator: problem.validation?.comparator || "trimmed-exact",
      testCases: fromValidation,
    };
  }

  const fromTopLevel = Array.isArray(problem.testCases)
    ? problem.testCases.map(normalizeTestCase).filter(Boolean)
    : [];

  if (fromTopLevel.length > 0) {
    return {
      mode: "test-cases",
      comparator: "trimmed-exact",
      testCases: fromTopLevel,
    };
  }

  if (
    typeof problem.sampleInput !== "undefined" &&
    typeof problem.sampleOutput !== "undefined"
  ) {
    return {
      mode: "test-cases",
      comparator: "trimmed-exact",
      testCases: [
        {
          input: String(problem.sampleInput),
          expectedOutput: String(problem.sampleOutput),
        },
      ],
    };
  }

  if (typeof problem.validator === "function") {
    return {
      mode: "legacy-validator",
      comparator: "legacy-validator",
      testCases: [],
      validateCode: problem.validator,
    };
  }

  return {
    mode: "none",
    comparator: "trimmed-exact",
    testCases: [],
  };
}

function compareOutputs(actual, expected, comparator = "trimmed-exact") {
  if (comparator === "trimmed-exact") {
    return toTrimmedText(actual) === toTrimmedText(expected);
  }

  return String(actual ?? "") === String(expected ?? "");
}

const problems = [
  {
    id: "p-two-sum",
    title: "Two Sum",
    difficulty: "easy",
    description:
      "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.",
    constraints: [
      "2 <= nums.length <= 10^4",
      "-10^9 <= nums[i] <= 10^9",
      "-10^9 <= target <= 10^9",
    ],
    sampleInput: "nums = [2,7,11,15], target = 9",
    sampleOutput: "[0,1]",
    validation: {
      comparator: "trimmed-exact",
      testCases: [
        {
          input: "nums = [2,7,11,15], target = 9",
          expectedOutput: "[0,1]",
        },
      ],
    },
  },
  {
    id: "p-valid-parentheses",
    title: "Valid Parentheses",
    difficulty: "easy",
    description:
      "Given a string s containing just the characters '(', ')', '{', '}', '[' and ']', determine if the input string is valid.",
    constraints: ["1 <= s.length <= 10^4"],
    sampleInput: 's = "()[]{}"',
    sampleOutput: "true",
    validation: {
      comparator: "trimmed-exact",
      testCases: [
        {
          input: 's = "()[]{}"',
          expectedOutput: "true",
        },
      ],
    },
  },
  {
    id: "p-binary-search",
    title: "Binary Search",
    difficulty: "medium",
    description:
      "Given a sorted array of integers and a target value, return the index of target or -1 if not found.",
    constraints: ["1 <= nums.length <= 10^5"],
    sampleInput: "nums = [-1,0,3,5,9,12], target = 9",
    sampleOutput: "4",
    validation: {
      comparator: "trimmed-exact",
      testCases: [
        {
          input: "nums = [-1,0,3,5,9,12], target = 9",
          expectedOutput: "4",
        },
      ],
    },
  },
];

function randomProblem(difficulty) {
  const pool = problems.filter((p) => p.difficulty === difficulty);
  const source = pool.length > 0 ? pool : problems;
  return source[Math.floor(Math.random() * source.length)];
}

module.exports = {
  SUPPORTED_LANGUAGES,
  buildValidationContract,
  compareOutputs,
  problems,
  randomProblem,
};
