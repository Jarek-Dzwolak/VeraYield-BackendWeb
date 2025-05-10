/**
 * Instance Routes - ścieżki do zarządzania instancjami strategii
 *
 * Zawiera endpointy:
 * - Tworzenie, aktualizacja i usuwanie instancji
 * - Zarządzanie statusem instancji
 * - Pobieranie danych instancji
 */

const express = require("express");
const router = express.Router();
const instanceController = require("../controllers/instance.controller");
const authMiddleware = require("../middleware/auth.middleware");
const validatorMiddleware = require("../middleware/validator.middleware");

// Middleware autentykacji dla wszystkich ścieżek
router.use(authMiddleware.verifyToken);

// Pobieranie wszystkich instancji
router.get("/", instanceController.getAllInstances);

// Pobieranie tylko aktywnych instancji
router.get("/active", instanceController.getActiveInstances);

// Pobieranie konkretnej instancji po ID
router.get("/:instanceId", instanceController.getInstance);

// Tworzenie nowej instancji
router.post(
  "/",
  validatorMiddleware.validateInstanceCreation,
  instanceController.createInstance
);

// Aktualizacja instancji
router.put(
  "/:instanceId",
  validatorMiddleware.validateInstanceUpdate,
  instanceController.updateInstance
);

// Usuwanie instancji
router.delete("/:instanceId", instanceController.deleteInstance);

// Uruchamianie instancji
router.post("/:instanceId/start", instanceController.startInstance);

// Zatrzymywanie instancji
router.post("/:instanceId/stop", instanceController.stopInstance);

// Pobieranie stanu instancji (bieżące dane analizy, pozycje itp.)
router.get("/:instanceId/state", instanceController.getInstanceState);

// Pobieranie wyników instancji (statystyki, historia sygnałów)
router.get("/:instanceId/results", instanceController.getInstanceResults);

// Pobieranie konfiguracji instancji
router.get("/:instanceId/config", instanceController.getInstanceConfig);

// Aktualizacja konfiguracji instancji
router.put(
  "/:instanceId/config",
  validatorMiddleware.validateInstanceConfigUpdate,
  instanceController.updateInstanceConfig
);

// Klonowanie instancji
router.post("/:instanceId/clone", instanceController.cloneInstance);

// Porównanie wyników dwóch instancji
router.get(
  "/compare/:instanceId1/:instanceId2",
  instanceController.compareInstances
);

// Zatrzymanie wszystkich instancji (tylko dla admina)
router.post(
  "/stop-all",
  authMiddleware.isAdmin,
  instanceController.stopAllInstances
);
router.put("/:instanceId/bybit-config", instanceController.updateBybitConfig);

module.exports = router;
