const express = require("express");
const router = express.Router();
const { getProfile, updateProfile, changePassword, getPresignedUrl, confirmProfilePicture } = require("../controllers/userController");
const validate = require("../middleware/validate");
const { updateProfileSchema, changePasswordSchema, confirmPictureSchema } = require("../validators/authValidators");

/**
 * @openapi
 * /api/v1/user/profile:
 *   get:
 *     summary: Get current user's profile
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile
 *       404:
 *         description: User not found
 */
router.get("/profile", getProfile);

/**
 * @openapi
 * /api/v1/user/profile/presign:
 *   get:
 *     summary: Get a presigned S3 PUT URL for the current user's profile picture
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: contentType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [image/jpeg, image/png, image/webp, image/gif]
 *     responses:
 *       200:
 *         description: Presigned upload URL
 *       400:
 *         description: Unsupported content type
 */
router.get("/profile/presign", getPresignedUrl);

/**
 * @openapi
 * /api/v1/user/profile/picture:
 *   post:
 *     summary: Confirm a profile picture upload and store its public URL
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               versionId:
 *                 type: string
 *                 description: S3 version id returned by the PUT (x-amz-version-id); used as a cache-buster
 *     responses:
 *       200:
 *         description: Profile picture updated
 *       404:
 *         description: User not found
 */
router.post("/profile/picture", validate(confirmPictureSchema), confirmProfilePicture);

/**
 * @openapi
 * /api/v1/user/profile:
 *   patch:
 *     summary: Update current user's profile
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Profile updated
 *       400:
 *         description: Validation error
 *       409:
 *         description: Email already in use
 */
router.patch("/profile", validate(updateProfileSchema), updateProfile);

/**
 * @openapi
 * /api/v1/user/password:
 *   patch:
 *     summary: Change current user's password
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password changed
 *       400:
 *         description: Validation error
 *       401:
 *         description: Current password incorrect
 */
router.patch("/password", validate(changePasswordSchema), changePassword);

module.exports = router;
