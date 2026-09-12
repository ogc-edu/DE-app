const User = require("../models/user");
const bcrypt = require("bcrypt");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3Client, profileImageKey, buildPublicObjectUrl } = require("../config/s3");

// Content types allowed for profile pictures (frontend enforces the 5 MB cap;
// a fixed per-user key means every upload overwrites the same object so bucket
// versioning bumps the version on each re-upload).
const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const PRESIGN_URL_EXPIRES_IN_SECONDS = 300; // 5 minutes

const getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).select("-refreshTokenHash -password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
};

const updateProfile = async (req, res, next) => {
  try {
    const { username, email, affiliation } = req.body;
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (username) user.username = username;
    if (email) {
      const existing = await User.findOne({ email, _id: { $ne: req.userId } });
      if (existing) {
        return res.status(400).json({ message: "Email already in use" });
      }
      user.email = email;
    }
    if (affiliation !== undefined) user.affiliation = affiliation;

    await user.save();
    const updated = await User.findById(req.userId).select("-refreshTokenHash -password");
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
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Called only after the client successfully PUT the file to S3.
    const key = profileImageKey(req.userId);
    user.profilePicture = buildPublicObjectUrl(key, versionId);
    await user.save();

    const updated = await User.findById(req.userId).select("-refreshTokenHash -password");
    res.status(200).json({ message: "Profile picture updated successfully", user: updated });
  } catch (err) {
    next(err);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.userId).select("+password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    if (newPassword.length > 12) {
      return res.status(400).json({ message: "Password cannot exceed 12 characters" });
    }

    user.password = newPassword;
    // End all existing sessions; the user must log in again.
    user.refreshTokenHash = null;
    await user.save();

    res.status(200).json({ message: "Password changed successfully" });
  } catch (err) {
    next(err);
  }
};

module.exports = { getProfile, updateProfile, changePassword, getPresignedUrl, confirmProfilePicture };
