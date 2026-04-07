const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const users = [];
const activeRooms = new Map();
const waitingByDifficulty = {
  easy: null,
  medium: null,
  hard: null,
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
    const user = await UserModel.findOne({ username: new RegExp(`^${username}$`, "i") }).lean(false);
    return normalizeUser(user);
  }

  return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
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

async function updateMatchOutcome(winnerId, loserId, updatedValues) {
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
  }

  if (loser) {
    loser.rating = updatedValues.loser.rating;
    loser.losses = updatedValues.loser.losses;
    loser.matchesPlayed = updatedValues.loser.matchesPlayed;
  }
}

async function getUsersByIds(ids) {
  if (hasMongo) {
    const result = await UserModel.find({ id: { $in: ids } }).lean();
    return result.map((u) => normalizeUser(u));
  }

  return users.filter((u) => ids.includes(u.id));
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
  users,
  waitingByDifficulty,
  activeRooms,
  hasMongo,
};
