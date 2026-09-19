const express = require("express");
const router = express.Router();
const {
  createSimulation,
  importSimulation,
  getAllSimulations,
  deleteSimulation,
  cancelSimulation,
  getSingleSimulation,
  getSimulationResults,
} = require("../controllers/simulationController");
const validate = require("../middleware/validate");
const {
  createSimulationSchema,
  importSimulationSchema,
} = require("../validators/simulationValidators");

/**
 * @openapi
 * /api/v1/simulation/create:
 *   post:
 *     summary: Create a new simulation
 *     tags: [Simulation]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [functions, methods]
 *             properties:
 *               functions:
 *                 type: array
 *                 items:
 *                   type: integer
 *               methods:
 *                 type: object
 *                 properties:
 *                   mutation:
 *                     type: array
 *                     items:
 *                       type: integer
 *                   crossover:
 *                     type: array
 *                     items:
 *                       type: integer
 *                   selection:
 *                     type: array
 *                     items:
 *                       type: integer
 *               np:
 *                 type: number
 *                 description: Population size (10-40, default 15)
 *               f:
 *                 type: number
 *                 description: Scaling factor (0.1-2.0, default 0.5)
 *               cr:
 *                 type: number
 *                 description: Crossover rate (0.01-1.0, default 0.9)
 *               gen:
 *                 type: integer
 *                 description: Number of generations (>=1, default 1000)
 *               dim:
 *                 type: integer
 *                 description: Dimension (1-30, must match de.cpp; default 30)
 *     responses:
 *       201:
 *         description: Simulation created (and enqueued to SQS)
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Unauthorized
 */
router.post("/create", validate(createSimulationSchema), createSimulation);

/**
 * @openapi
 * /api/v1/simulation/import:
 *   post:
 *     summary: Import a user-provided .txt results file as a completed simulation
 *     tags: [Simulation]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *                 description: Raw .txt file content (see import-format.md)
 *               filename:
 *                 type: string
 *                 description: Optional original filename
 *     responses:
 *       201:
 *         description: Simulation imported successfully
 *       400:
 *         description: Validation or file-format error (with line numbers)
 *       401:
 *         description: Unauthorized
 */
router.post("/import", validate(importSimulationSchema), importSimulation);

/**
 * @openapi
 * /api/v1/simulation/get:
 *   get:
 *     summary: Get all simulations for the authenticated user
 *     description: >-
 *       Cursor-paginated list (DynamoDB `LastEvaluatedKey` encoded as an opaque
 *       base64 string). There is no `page`/offset parameter. IDs are UUID
 *       strings, not Mongo ObjectIds.
 *     tags: [Simulation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: >-
 *           Maximum number of simulations to return. `0` (default) returns all
 *           simulations (internally paged, capped at 1000).
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: >-
 *           Opaque cursor (`nextCursor`) from a previous response. Omit for the
 *           first page. A malformed value returns 400.
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, running, completed, failed, cancelled]
 *         description: Filter results by simulation status.
 *     responses:
 *       200:
 *         description: Cursor-paginated list of the authenticated user's simulations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
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
 *                 simulationCount:
 *                   type: integer
 *                   description: Number of simulations in this page
 *                 nextCursor:
 *                   type: string
 *                   nullable: true
 *                   description: Pass as `cursor` for the next page; null when exhausted
 *       401:
 *         description: Unauthorized
 */
router.get("/get", getAllSimulations);

/**
 * @openapi
 * /api/v1/simulation/get/{simulationId}/results:
 *   get:
 *     summary: Get simulation results grid
 *     description: >-
 *       Live/polled progress plus the results grid. Results are stored as
 *       separate DynamoDB items (never inline on the simulation). The simulation
 *       id is a UUID string, not a Mongo ObjectId.
 *     tags: [Simulation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: simulationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Simulation UUID string
 *     responses:
 *       200:
 *         description: Simulation status/progress and its results grid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 simulationId:
 *                   type: string
 *                   format: uuid
 *                 status:
 *                   type: string
 *                   enum: [pending, running, completed, failed, cancelled]
 *                 totalModels:
 *                   type: integer
 *                 completedModels:
 *                   type: integer
 *                 progress:
 *                   type: number
 *                 simulationData:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       functionId:
 *                         type: integer
 *                       mutationId:
 *                         type: integer
 *                       crossoverId:
 *                         type: integer
 *                       selectionId:
 *                         type: integer
 *                       lowestFitness:
 *                         type: number
 *       403:
 *         description: Not authorized to access this simulation
 *       404:
 *         description: Simulation not found
 */
router.get("/get/:simulationId/results", getSimulationResults);

/**
 * @openapi
 * /api/v1/simulation/get/{simulationId}:
 *   get:
 *     summary: Get a single simulation by ID
 *     tags: [Simulation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: simulationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Simulation UUID string
 *     responses:
 *       200:
 *         description: Simulation details
 *       403:
 *         description: Not authorized to access this simulation
 *       404:
 *         description: Simulation not found
 */
router.get("/get/:simulationId", getSingleSimulation);

/**
 * @openapi
 * /api/v1/simulation/delete/{simulationId}:
 *   delete:
 *     summary: Delete a simulation
 *     tags: [Simulation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: simulationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Simulation UUID string
 *     responses:
 *       200:
 *         description: Simulation deleted
 *       403:
 *         description: Not authorized to delete this simulation
 *       404:
 *         description: Simulation not found
 */
router.delete("/delete/:simulationId", deleteSimulation);

/**
 * @openapi
 * /api/v1/simulation/cancel/{simulationId}:
 *   post:
 *     summary: Cancel a simulation
 *     tags: [Simulation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: simulationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Simulation UUID string
 *     responses:
 *       200:
 *         description: Simulation cancelled
 *       403:
 *         description: Not authorized to cancel this simulation
 *       404:
 *         description: Simulation not found
 *       409:
 *         description: Simulation is already in a terminal status (completed, failed or cancelled)
 */
router.post("/cancel/:simulationId", cancelSimulation);

module.exports = router;
