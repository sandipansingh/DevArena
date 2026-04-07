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
    validator: (code) => {
      const normalized = code.toLowerCase();
      return normalized.includes("for") && normalized.includes("return");
    },
  },
  {
    id: "p-valid-parentheses",
    title: "Valid Parentheses",
    difficulty: "easy",
    description:
      "Given a string s containing just the characters '(', ')', '{', '}', '[' and ']', determine if the input string is valid.",
    constraints: ["1 <= s.length <= 10^4"],
    sampleInput: "s = \"()[]{}\"",
    sampleOutput: "true",
    validator: (code) => {
      const normalized = code.toLowerCase();
      return normalized.includes("stack") || normalized.includes("push");
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
    validator: (code) => {
      const normalized = code.toLowerCase();
      return normalized.includes("while") && normalized.includes("mid");
    },
  },
];

function randomProblem(difficulty) {
  const pool = problems.filter((p) => p.difficulty === difficulty);
  const source = pool.length > 0 ? pool : problems;
  return source[Math.floor(Math.random() * source.length)];
}

module.exports = { problems, randomProblem };
