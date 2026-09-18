const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const User = require("../models/user");
const { signAccessToken, signRefreshToken } = require("../utils/tokens");

const verify = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const safeUser = User.toSafeUser(user);
    const userData = {
      userId: user.userId,
      username: safeUser.username,
      email: safeUser.email,
      affiliation: safeUser.affiliation,
      profilePicture: safeUser.profilePicture,
      role: safeUser.role,
    };
    res.status(200).json({ status: true, userData: userData });
  } catch (err) {
    next(err);
  }
};

const refresh = async (req, res, next) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
      return res.status(401).json({ message: "No refresh token provided" });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    // Defense-in-depth: a suspended user must not refresh even if a stale hash
    // somehow survived.
    if (!user.isActive) {
      return res.status(401).json({ message: "Account has been suspended" });
    }

    // Compare digests in constant time. Hashing the presented token normalizes
    // any input to 64 hex chars; the length guard covers a malformed stored value.
    const presented = Buffer.from(User.hashRefreshToken(refreshToken), "hex");
    const stored = Buffer.from(user.refreshTokenHash || "", "hex");
    if (
      user.refreshTokenHash == null ||
      presented.length !== stored.length ||
      !crypto.timingSafeEqual(presented, stored)
    ) {
      return res.status(401).json({ message: "Refresh token does not match" });
    }

    const newAccessToken = signAccessToken(user);
    const newRefreshToken = signRefreshToken(user);
    await User.saveRefreshToken(user.userId, newRefreshToken);

    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({ message: "Token refreshed successfully", token: newAccessToken });
  } catch (err) {
    next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
      return res.status(200).json({ message: "Already logged out" });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      res.clearCookie("refreshToken");
      return res.status(200).json({ message: "Logged out successfully" });
    }

    const user = await User.findById(decoded.userId);
    if (user) {
      await User.clearRefreshToken(user.userId);
    }

    res.clearCookie("refreshToken");
    res.status(200).json({ message: "Logged out successfully" });
  } catch (err) {
    next(err);
  }
};

module.exports = { verify, refresh, logout };