/**
 * Authentication Middleware - middleware do obsługi autentykacji
 *
 * Odpowiedzialny za:
 * - Weryfikację tokenów JWT
 * - Sprawdzanie uprawnień użytkownika
 * - Zabezpieczanie tras przed nieautoryzowanym dostępem
 */

const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const logger = require("../utils/logger");

// Sekret JWT (w produkcji powinien być w zmiennych środowiskowych)
const JWT_SECRET = process.env.JWT_SECRET || "binance-trading-bot-secret";

/**
 * Weryfikuje token JWT
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 * @param {Function} next - Funkcja do przejścia do następnego middleware'a
 */
const verifyToken = async (req, res, next) => {
  try {
    // Pobierz token z nagłówka Authorization
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "No authorization token provided",
      });
    }

    // Sprawdź format tokenu (Bearer TOKEN)
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid token format",
      });
    }

    const token = parts[1];

    // Weryfikuj token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Sprawdź, czy użytkownik istnieje
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "User not found",
      });
    }

    // Sprawdź, czy konto jest aktywne
    if (user.status !== "active") {
      return res.status(403).json({
        error: "Forbidden",
        message: "Account is inactive or suspended",
      });
    }

    // Dodaj informacje o użytkowniku do obiektu żądania
    req.user = {
      id: user._id,
      email: user.email,
      role: user.role,
    };

    next();
  } catch (error) {
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError"
    ) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid or expired token",
      });
    }

    logger.error(`Błąd w middleware autentykacji: ${error.message}`);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred during authentication",
    });
  }
};

/**
 * Sprawdza, czy użytkownik ma rolę administratora
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 * @param {Function} next - Funkcja do przejścia do następnego middleware'a
 */
const isAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Authentication required",
    });
  }

  if (req.user.role !== "admin") {
    return res.status(403).json({
      error: "Forbidden",
      message: "Admin privileges required",
    });
  }

  next();
};

/**
 * Sprawdza, czy użytkownik ma rolę managera lub wyższą
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 * @param {Function} next - Funkcja do przejścia do następnego middleware'a
 */
const isManager = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Authentication required",
    });
  }

  if (req.user.role !== "admin" && req.user.role !== "manager") {
    return res.status(403).json({
      error: "Forbidden",
      message: "Manager privileges required",
    });
  }

  next();
};

/**
 * Sprawdza, czy użytkownik ma dostęp do danej instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 * @param {Function} next - Funkcja do przejścia do następnego middleware'a
 */
const hasInstanceAccess = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Authentication required",
      });
    }

    const instanceId = req.params.instanceId;
    if (!instanceId) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Instance ID is required",
      });
    }

    // Admini mają dostęp do wszystkich instancji
    if (req.user.role === "admin") {
      return next();
    }

    // Pobierz pełny profil użytkownika
    const user = await User.findById(req.user.id);

    // Sprawdź, czy użytkownik ma dostęp do instancji
    if (!user.instances.includes(instanceId)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "You do not have access to this instance",
      });
    }

    next();
  } catch (error) {
    logger.error(
      `Błąd podczas sprawdzania dostępu do instancji: ${error.message}`
    );
    return res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while checking instance access",
    });
  }
};

module.exports = {
  verifyToken,
  isAdmin,
  isManager,
  hasInstanceAccess,
};
