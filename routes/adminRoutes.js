const express = require("express");
const router = express.Router();
const {
  getAllUsers,
  getUserById,
  toggleSuspendUser,
  getAllSimulations,
  deleteAnySimulation,
  getQueueStatus,
} = require("../controllers/adminController");

/**
 * @openapi
 * /api/v1/admin/users:
 *   get:
 *     summary: List all users (admin only)
 *     description: >-
 *       Cursor-paginated scan of the users table (opaque base64 cursor). There
 *       is no `page`/offset parameter. User ids are UUID strings, not Mongo
 *       ObjectIds.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 20
 *         description: Maximum number of users to return (default 20).
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: >-
 *           Opaque cursor (`nextCursor`) from a previous response. Omit for the
 *           first page. A malformed value returns 400.
 *     responses:
 *       200:
 *         description: Cursor-paginated list of users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                         description: Alias of `userId` (UUID string, not a Mongo ObjectId)
 *                       userId:
 *                         type: string
 *                         format: uuid
 *                       username:
 *                         type: string
 *                       email:
 *                         type: string
 *                         format: email
 *                       role:
 *                         type: string
 *                         enum: [user, admin]
 *                       isActive:
 *                         type: boolean
 *                       profilePicture:
 *                         type: string
 *                         nullable: true
 *                       affiliation:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                 nextCursor:
 *                   type: string
 *                   nullable: true
 *                   description: Pass as `cursor` for the next page; null when exhausted
 *       403:
 *         description: Admin access required
 */
router.get("/users", getAllUsers);

/**
 * @openapi
 * /api/v1/admin/users/{id}:
 *   get:
 *     summary: Get a single user by ID (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User details
 *       404:
 *         description: User not found
 */
router.get("/users/:id", getUserById);

/**
 * @openapi
 * /api/v1/admin/users/{id}/suspend:
 *   patch:
 *     summary: Toggle user active/suspended status (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User status toggled
 *       400:
 *         description: Cannot suspend admin
 *       404:
 *         description: User not found
 */
router.patch("/users/:id/suspend", toggleSuspendUser);

/**
 * @openapi
 * /api/v1/admin/simulations:
 *   get:
 *     summary: List all simulations across all users (admin only)
 *     description: >-
 *       Cursor-paginated scan of the simulations table, optionally filtered by
 *       `userId`. There is no `page`/offset parameter. IDs are UUID strings, not
 *       Mongo ObjectIds. Results (`simulationData`) are separate items and are
 *       not included in this list.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter to a single user's simulations (UUID string).
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 50
 *         description: Maximum number of simulations to return (default 50).
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: >-
 *           Opaque cursor (`nextCursor`) from a previous response. Omit for the
 *           first page. A malformed value returns 400.
 *     responses:
 *       200:
 *         description: Cursor-paginated list of simulations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 simulationCount:
 *                   type: integer
 *                   description: Number of simulations in this page
 *                 simulations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                         description: Alias of `simulationId` (UUID string, not a Mongo ObjectId)
 *                       simulationId:
 *                         type: string
 *                         format: uuid
 *                       userId:
 *                         type: string
 *                         format: uuid
 *                       functions:
 *                         type: array
 *                         items:
 *                           type: integer
 *                       methods:
 *                         type: object
 *                         properties:
 *                           mutation:
 *                             type: array
 *                             items:
 *                               type: integer
 *                           crossover:
 *                             type: array
 *                             items:
 *                               type: integer
 *                           selection:
 *                             type: array
 *                             items:
 *                               type: integer
 *                       np:
 *                         type: number
 *                       f:
 *                         type: number
 *                       cr:
 *                         type: number
 *                       gen:
 *                         type: integer
 *                       dim:
 *                         type: integer
 *                       totalModels:
 *                         type: integer
 *                       completedModels:
 *                         type: integer
 *                       progress:
 *                         type: number
 *                       status:
 *                         type: string
 *                         enum: [pending, running, completed, failed, cancelled]
 *                       bestFitness:
 *                         type: number
 *                         nullable: true
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                 nextCursor:
 *                   type: string
 *                   nullable: true
 *                   description: Pass as `cursor` for the next page; null when exhausted
 *       403:
 *         description: Admin access required
 */
router.get("/simulations", getAllSimulations);

/**
 * @openapi
 * /api/v1/admin/simulations/{id}:
 *   delete:
 *     summary: Delete any simulation (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Simulation deleted
 *       404:
 *         description: Simulation not found
 */
router.delete("/simulations/:id", deleteAnySimulation);

/**
 * @openapi
 * /api/v1/admin/queue:
 *   get:
 *     summary: Get SQS queue status (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Real SQS queue metrics (depth, in-flight, delayed, oldest message age)
 *       503:
 *         description: SQS queue not configured (SQS_QUEUE_URL missing)
 */
router.get("/queue", getQueueStatus);

module.exports = router;
