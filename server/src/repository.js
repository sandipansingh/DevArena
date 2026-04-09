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

const hasMongo = Boolean(process.env.MONGODB_URI);

let UserModel;

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    rating: { type: Number, default: 1200 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    matchesPlayed: { type: Number, default: 0 },
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
    rating: plain.rating,
    wins: plain.wins,
    losses: plain.losses,
    matchesPlayed: plain.matchesPlayed,
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
  await addUser({ username: "demo", passwordHash });
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

async function addUser({ username, passwordHash }) {
  const user = {
    id: uuidv4(),
    username,
    passwordHash,
    rating: 1200,
    wins: 0,
    losses: 0,
    matchesPlayed: 0,
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
  isDbReady,
  getRuntimeStats,
  users,
  waitingByDifficulty,
  activeRooms,
  hasMongo,
};
