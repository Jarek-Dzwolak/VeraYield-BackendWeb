const express = require("express");
const router = express.Router();
const cooldownController = require("../controllers/cooldown.controller");
const authMiddleware = require("../middleware/auth.middleware");

// Middleware autentyfikacji dla wszystkich ścieżek
router.use(authMiddleware.verifyToken);

// Pobieranie informacji o cooldown dla konkretnej instancji
router.get("/:instanceId", cooldownController.getCooldownInfo);

// Pobieranie wszystkich aktywnych cooldowns
router.get("/", cooldownController.getAllCooldowns);

// Manualnie ustawia cooldown dla instancji (tylko admin)
router.post(
  "/:instanceId",
  authMiddleware.isAdmin,
  cooldownController.setCooldown
);

// Manualnie czyści cooldown dla instancji (tylko admin)
router.delete(
  "/:instanceId",
  authMiddleware.isAdmin,
  cooldownController.clearCooldown
);

// Czyści wszystkie cooldowns (tylko admin)
router.delete(
  "/",
  authMiddleware.isAdmin,
  cooldownController.clearAllCooldowns
);

module.exports = router;
