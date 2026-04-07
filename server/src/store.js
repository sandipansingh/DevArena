const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");

const users = [];
const waitingByDifficulty = {
  easy: null,
  medium: null,
  hard: null,
};

const activeRooms = new Map();

function seedUsers() {
  if (users.length > 0) {
    return;
  }

  const passwordHash = bcrypt.hashSync("password123", 10);
  users.push({
    id: uuidv4(),
    username: "demo",
    passwordHash,
    rating: 1200,
    wins: 0,
    losses: 0,
    matchesPlayed: 0,
    createdAt: new Date().toISOString(),
  });
}

function findUserByUsername(username) {
  return users.find((u) => u.username.toLowerCase() === username.toLowerCase());
}

function addUser({ username, passwordHash }) {
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

  users.push(user);
  return user;
}

module.exports = {
  users,
  waitingByDifficulty,
  activeRooms,
  seedUsers,
  findUserByUsername,
  addUser,
};
