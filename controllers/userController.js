const User = require("../models/user");
const bcrypt = require("bcrypt");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3Client, profileImageKey, buildPublicObjectUrl } = require("../config/s3");
const { UnauthorizedError } = require("../utils/errors");

// Content types allowed for profile pictures (frontend enforces the 5 MB cap;
// a fixed per-user key means every upload overwrites the same object so bucket
// versioning bumps the version on each re-upload).
const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const PRESIGN_URL_EXPIRES_IN_SECONDS = 300; // 5 minutes

const getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json({ user: User.toSafeUser(user) });
  } catch (err) {
    next(err);
  }
};

const updateProfile = async (req, res, next) => {
  try {
    const { username, email, affiliation } = req.body;
    const updated = await User.updateProfile(req.userId, { username, email, affiliation });
    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json({ message: "Profile updated successfully", user: updated });
  } catch (err) {
    next(err);
  }
};

const getPresignedUrl = async (req, res, next) => {
  try {
    const { contentType } = req.query;
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return res.status(400).json({
        message: `Unsupported content type. Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}`,
      });
    }

    const key = profileImageKey(req.userId);
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGN_URL_EXPIRES_IN_SECONDS,
    });

    res.status(200).json({
      uploadUrl,
      key,
      contentType,
      expiresIn: PRESIGN_URL_EXPIRES_IN_SECONDS,
    });
  } catch (err) {
    next(err);
  }
};

const confirmProfilePicture = async (req, res, next) => {
  try {
    const { versionId } = req.body;

    // Called only after the client successfully PUT the file to S3.
    const key = profileImageKey(req.userId);
    const updated = await User.updateProfile(req.userId, {
      profilePicture: buildPublicObjectUrl(key, versionId),
    });
    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ message: "Profile picture updated successfully", user: updated });
  } catch (err) {
    next(err);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedError("Current password is incorrect");
    }

    // changePassword enforces the 12-char max (BadRequestError -> 400) and
    // clears refreshTokenHash to end all existing sessions.
    await User.changePassword(req.userId, newPassword);

    res.status(200).json({ message: "Password changed successfully" });
  } catch (err) {
    next(err);
  }
};

module.exports = { getProfile, updateProfile, changePassword, getPresignedUrl, confirmProfilePicture };
