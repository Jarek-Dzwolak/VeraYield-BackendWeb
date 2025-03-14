/**
 * Authentication Routes - ścieżki do obsługi autentykacji
 *
 * Zawiera endpointy:
 * - Rejestracja użytkownika
 * - Logowanie
 * - Wylogowanie
 * - Reset hasła
 * - Pobieranie informacji o użytkowniku
 */

const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const authMiddleware = require("../middleware/auth.middleware");

// Rejestracja nowego użytkownika
router.post("/register", authController.register);

// Logowanie użytkownika
router.post("/login", authController.login);

// Wylogowanie użytkownika
router.post("/logout", authMiddleware.verifyToken, authController.logout);

// Pobieranie informacji o profilu użytkownika
router.get("/profile", authMiddleware.verifyToken, authController.getProfile);

// Aktualizacja profilu użytkownika
router.put(
  "/profile",
  authMiddleware.verifyToken,
  authController.updateProfile
);

// Zmiana hasła
router.put(
  "/change-password",
  authMiddleware.verifyToken,
  authController.changePassword
);

// Żądanie resetowania hasła (wysyła email z tokenem)
router.post("/forgot-password", authController.forgotPassword);

// Resetowanie hasła (z tokenem)
router.post("/reset-password/:token", authController.resetPassword);

// Weryfikacja tokenu resetowania hasła
router.get("/verify-reset-token/:token", authController.verifyResetToken);

// Pobieranie aktualnego statusu autentykacji
router.get("/status", authController.getAuthStatus);

module.exports = router;
