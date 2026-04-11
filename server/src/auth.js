const jwt = require("jsonwebtoken");
const { config } = require("./config");

const JWT_SECRET = config.JWT_SECRET;

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role || "developer",
    },
    JWT_SECRET,
    { expiresIn: "12h" },
  );
}

function authMiddleware(req, res, next) {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";

  if (!token) {
    return res.status(401).json({ message: "Missing token" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

function verifySocketToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { signToken, authMiddleware, verifySocketToken };
