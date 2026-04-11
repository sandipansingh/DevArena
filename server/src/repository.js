const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const users = [];
const activeRooms = new Map();
const waitingByDifficulty = {
  easy: [],
  medium: [],
  hard: [],
};

function ratingToTier(rating) {
  const value = Number(rating || 1200);
  if (value >= 1800) {
    return "Platinum";
  }
  if (value >= 1500) {
    return "Gold";
  }
  if (value >= 1300) {
    return "Silver";
  }
  return "Bronze";
}

const hasMongo = Boolean(process.env.MONGODB_URI);

let UserModel;

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ["developer", "recruiter", "admin"],
      default: "developer",
      index: true,
    },
    primaryLanguages: {
      type: [String],
      default: [],
    },
    rating: { type: Number, default: 1200 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    matchesPlayed: { type: Number, default: 0 },
    aiFeedback: {
      type: [
        {
          id: { type: String, required: true },
          roomId: { type: String, required: true },
          summary: { type: String, required: true },
          winnerReason: { type: String, required: true },
          strengths: { type: String, default: "" },
          weaknesses: { type: String, default: "" },
          suggestions: { type: String, default: "" },
          qualityScore: { type: Number, default: null },
          generatedAt: { type: Date, required: true },
        },
      ],
      default: [],
    },
    recentMatches: {
      type: [
        {
          roomId: { type: String, required: true },
          opponentId: { type: String, required: true },
          opponentUsername: { type: String, required: true },
          result: { type: String, enum: ["win", "loss"], required: true },
          reason: { type: String, required: true },
          ratingBefore: { type: Number, required: true },
          ratingAfter: { type: Number, required: true },
          ratingDelta: { type: Number, required: true },
          endedAt: { type: Date, required: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

if (hasMongo) {
  UserModel = mongoose.models.User || mongoose.model("User", userSchema);
}

async function connectDb() {
  if (!hasMongo || mongoose.connection.readyState === 1) {
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 10,
  });
}

async function disconnectDb() {
  if (!hasMongo || mongoose.connection.readyState === 0) {
    return;
  }

  await mongoose.disconnect();
}

function normalizeUser(user) {
  if (!user) {
    return null;
  }

  const plain = typeof user.toObject === "function" ? user.toObject() : user;
  return {
    id: plain.id,
    username: plain.username,
    passwordHash: plain.passwordHash,
    role: plain.role || "developer",
    primaryLanguages: Array.isArray(plain.primaryLanguages)
      ? plain.primaryLanguages
      : [],
    rating: plain.rating,
    wins: plain.wins,
    losses: plain.losses,
    matchesPlayed: plain.matchesPlayed,
    aiFeedback: Array.isArray(plain.aiFeedback) ? plain.aiFeedback : [],
    recentMatches: Array.isArray(plain.recentMatches)
      ? plain.recentMatches
      : [],
    createdAt: plain.createdAt,
  };
}

async function seedUsers() {
  const existing = await findUserByUsername("demo");
  if (existing) {
    return;
  }

  const passwordHash = bcrypt.hashSync("password123", 10);
  await addUser({
    username: "demo",
    passwordHash,
    role: "developer",
    primaryLanguages: ["javascript"],
  });
}

async function findUserByUsername(username) {
  if (hasMongo) {
    const user = await UserModel.findOne({
      username: new RegExp(`^${username}$`, "i"),
    }).lean(false);
    return normalizeUser(user);
  }

  return (
    users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ||
    null
  );
}

async function getUserById(id) {
  if (hasMongo) {
    const user = await UserModel.findOne({ id }).lean(false);
    return normalizeUser(user);
  }

  return users.find((u) => u.id === id) || null;
}

async function addUser({ username, passwordHash, role, primaryLanguages }) {
  const normalizedRole =
    role === "recruiter" || role === "admin" ? role : "developer";
  const normalizedLanguages = Array.isArray(primaryLanguages)
    ? primaryLanguages
        .map((language) =>
          String(language || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean)
        .slice(0, 8)
    : [];

  const user = {
    id: uuidv4(),
    username,
    passwordHash,
    role: normalizedRole,
    primaryLanguages: normalizedLanguages,
    rating: 1200,
    wins: 0,
    losses: 0,
    matchesPlayed: 0,
    aiFeedback: [],
    recentMatches: [],
    createdAt: new Date().toISOString(),
  };

  if (hasMongo) {
    const created = await UserModel.create(user);
    return normalizeUser(created);
  }

  users.push(user);
  return user;
}

async function listLeaderboard(limit = 20) {
  if (hasMongo) {
    const result = await UserModel.find({})
      .sort({ rating: -1 })
      .limit(limit)
      .lean();

    return result.map((u) => normalizeUser(u));
  }

  return [...users].sort((a, b) => b.rating - a.rating).slice(0, limit);
}

async function updateMatchOutcome(
  winnerId,
  loserId,
  updatedValues,
  matchContext = null,
) {
  const winnerEntry =
    matchContext && updatedValues
      ? {
          roomId: matchContext.roomId,
          opponentId: loserId,
          opponentUsername: matchContext.loserUsername,
          result: "win",
          reason: matchContext.reason,
          ratingBefore: updatedValues.winner.ratingBefore,
          ratingAfter: updatedValues.winner.rating,
          ratingDelta:
            updatedValues.winner.rating - updatedValues.winner.ratingBefore,
          endedAt: new Date(matchContext.endedAt),
        }
      : null;

  const loserEntry =
    matchContext && updatedValues
      ? {
          roomId: matchContext.roomId,
          opponentId: winnerId,
          opponentUsername: matchContext.winnerUsername,
          result: "loss",
          reason: matchContext.reason,
          ratingBefore: updatedValues.loser.ratingBefore,
          ratingAfter: updatedValues.loser.rating,
          ratingDelta:
            updatedValues.loser.rating - updatedValues.loser.ratingBefore,
          endedAt: new Date(matchContext.endedAt),
        }
      : null;

  if (hasMongo) {
    await Promise.all([
      UserModel.updateOne(
        { id: winnerId },
        {
          $set: {
            rating: updatedValues.winner.rating,
            wins: updatedValues.winner.wins,
            matchesPlayed: updatedValues.winner.matchesPlayed,
          },
          ...(winnerEntry
            ? {
                $push: {
                  recentMatches: {
                    $each: [winnerEntry],
                    $position: 0,
                    $slice: 20,
                  },
                },
              }
            : {}),
        },
      ),
      UserModel.updateOne(
        { id: loserId },
        {
          $set: {
            rating: updatedValues.loser.rating,
            losses: updatedValues.loser.losses,
            matchesPlayed: updatedValues.loser.matchesPlayed,
          },
          ...(loserEntry
            ? {
                $push: {
                  recentMatches: {
                    $each: [loserEntry],
                    $position: 0,
                    $slice: 20,
                  },
                },
              }
            : {}),
        },
      ),
    ]);
    return;
  }

  const winner = users.find((u) => u.id === winnerId);
  const loser = users.find((u) => u.id === loserId);

  if (winner) {
    winner.rating = updatedValues.winner.rating;
    winner.wins = updatedValues.winner.wins;
    winner.matchesPlayed = updatedValues.winner.matchesPlayed;
    winner.recentMatches = Array.isArray(winner.recentMatches)
      ? winner.recentMatches
      : [];
    if (winnerEntry) {
      winner.recentMatches.unshift(winnerEntry);
      winner.recentMatches = winner.recentMatches.slice(0, 20);
    }
  }

  if (loser) {
    loser.rating = updatedValues.loser.rating;
    loser.losses = updatedValues.loser.losses;
    loser.matchesPlayed = updatedValues.loser.matchesPlayed;
    loser.recentMatches = Array.isArray(loser.recentMatches)
      ? loser.recentMatches
      : [];
    if (loserEntry) {
      loser.recentMatches.unshift(loserEntry);
      loser.recentMatches = loser.recentMatches.slice(0, 20);
    }
  }
}

async function getUsersByIds(ids) {
  if (hasMongo) {
    const result = await UserModel.find({ id: { $in: ids } }).lean();
    return result.map((u) => normalizeUser(u));
  }

  return users.filter((u) => ids.includes(u.id));
}

async function addAiFeedbackForUser(userId, feedback) {
  const entry = {
    id: uuidv4(),
    roomId: String(feedback.roomId || ""),
    summary: String(feedback.summary || "No summary available"),
    winnerReason: String(
      feedback.winnerReason || "Winner chosen by execution result",
    ),
    strengths: String(feedback.strengths || ""),
    weaknesses: String(feedback.weaknesses || ""),
    suggestions: String(feedback.suggestions || ""),
    qualityScore:
      typeof feedback.qualityScore === "number" ? feedback.qualityScore : null,
    generatedAt: new Date(),
  };

  if (hasMongo) {
    await UserModel.updateOne(
      { id: userId },
      {
        $push: {
          aiFeedback: {
            $each: [entry],
            $position: 0,
            $slice: 50,
          },
        },
      },
    );
    return;
  }

  const user = users.find((candidate) => candidate.id === userId);
  if (!user) {
    return;
  }

  user.aiFeedback = Array.isArray(user.aiFeedback) ? user.aiFeedback : [];
  user.aiFeedback.unshift(entry);
  user.aiFeedback = user.aiFeedback.slice(0, 50);
}

async function listAiFeedbackByUser(userId, limit = 20) {
  const user = await getUserById(userId);
  if (!user) {
    return [];
  }

  const items = Array.isArray(user.aiFeedback) ? user.aiFeedback : [];
  return items.slice(0, limit).map((entry) => ({
    id: entry.id,
    roomId: entry.roomId,
    summary: entry.summary,
    winnerReason: entry.winnerReason,
    strengths: entry.strengths,
    weaknesses: entry.weaknesses,
    suggestions: entry.suggestions,
    qualityScore: entry.qualityScore,
    generatedAt:
      entry.generatedAt instanceof Date
        ? entry.generatedAt.toISOString()
        : new Date(entry.generatedAt).toISOString(),
  }));
}

async function listRecruiterCandidates({ tier, language, limit = 30 } = {}) {
  let pool;
  if (hasMongo) {
    const query = { role: "developer" };
    if (language) {
      query.primaryLanguages = String(language).toLowerCase();
    }
    pool = (
      await UserModel.find(query).sort({ rating: -1 }).limit(200).lean()
    ).map((user) => normalizeUser(user));
  } else {
    pool = users
      .filter((user) => user.role !== "recruiter" && user.role !== "admin")
      .filter((user) => {
        if (!language) {
          return true;
        }
        const langs = Array.isArray(user.primaryLanguages)
          ? user.primaryLanguages
          : [];
        return langs.includes(String(language).toLowerCase());
      })
      .sort((a, b) => b.rating - a.rating);
  }

  const normalizedTier = tier ? String(tier).trim().toLowerCase() : "";

  const filtered = pool.filter((user) => {
    if (!normalizedTier) {
      return true;
    }
    return ratingToTier(user.rating).toLowerCase() === normalizedTier;
  });

  return filtered.slice(0, limit).map((user) => {
    const wins = Number(user.wins || 0);
    const losses = Number(user.losses || 0);
    const matchesPlayed = Number(user.matchesPlayed || 0);
    const winRate =
      matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 100) : 0;
    const feedback = Array.isArray(user.aiFeedback) ? user.aiFeedback : [];
    const latestFeedback = feedback[0] || null;

    return {
      id: user.id,
      username: user.username,
      rating: user.rating,
      tier: ratingToTier(user.rating),
      wins,
      losses,
      matchesPlayed,
      winRate,
      primaryLanguages: Array.isArray(user.primaryLanguages)
        ? user.primaryLanguages
        : [],
      aiHighlight: latestFeedback
        ? {
            summary: latestFeedback.summary,
            suggestions: latestFeedback.suggestions,
            strengths: latestFeedback.strengths,
            qualityScore: latestFeedback.qualityScore,
            generatedAt:
              latestFeedback.generatedAt instanceof Date
                ? latestFeedback.generatedAt.toISOString()
                : new Date(latestFeedback.generatedAt).toISOString(),
          }
        : null,
    };
  });
}

function isDbReady() {
  if (!hasMongo) {
    return true;
  }

  return mongoose.connection.readyState === 1;
}

function getRuntimeStats() {
  return {
    queueSizes: {
      easy: Array.isArray(waitingByDifficulty.easy)
        ? waitingByDifficulty.easy.length
        : 0,
      medium: Array.isArray(waitingByDifficulty.medium)
        ? waitingByDifficulty.medium.length
        : 0,
      hard: Array.isArray(waitingByDifficulty.hard)
        ? waitingByDifficulty.hard.length
        : 0,
    },
    activeRooms: activeRooms.size,
    persistence: hasMongo ? "mongodb" : "memory",
  };
}

module.exports = {
  connectDb,
  disconnectDb,
  seedUsers,
  findUserByUsername,
  getUserById,
  addUser,
  listLeaderboard,
  updateMatchOutcome,
  getUsersByIds,
  addAiFeedbackForUser,
  listAiFeedbackByUser,
  listRecruiterCandidates,
  ratingToTier,
  isDbReady,
  getRuntimeStats,
  users,
  waitingByDifficulty,
  activeRooms,
  hasMongo,
};
