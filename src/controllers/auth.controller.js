/**
 * Authentication Controller - kontroler autentykacji
 *
 * Odpowiedzialny za:
 * - Rejestrację użytkowników
 * - Logowanie i wylogowanie
 * - Zarządzanie profilami użytkowników
 * - Resetowanie haseł
 */

const User = require("../models/user.model");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const logger = require("../utils/logger");

// Sekret JWT (w produkcji powinien być w zmiennych środowiskowych)
const JWT_SECRET = process.env.JWT_SECRET || "binance-trading-bot-secret";
// Czas ważności tokenu (1 dzień)
const JWT_EXPIRATION = "24h";

/**
 * Rejestruje nowego użytkownika
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const register = async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    // Sprawdź, czy użytkownik już istnieje
    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(400).json({
        error: "Registration Failed",
        message: "User with this email already exists",
      });
    }

    // Utwórz nowego użytkownika
    const newUser = new User({
      email,
      password,
      firstName,
      lastName,
      role: "user", // Domyślna rola
      status: "active",
    });

    // Zapisz użytkownika
    await newUser.save();

    // Zwróć sukces bez danych wrażliwych
    res.status(201).json({
      message: "User registered successfully",
      user: newUser.getProfile(),
    });
  } catch (error) {
    logger.error(`Błąd podczas rejestracji użytkownika: ${error.message}`);
    res.status(500).json({
      error: "Registration Failed",
      message: "An error occurred during registration",
    });
  }
};

/**
 * Loguje użytkownika
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(`Próba logowania dla email: ${email}`);

    // Znajdź użytkownika
    const user = await User.findByEmail(email);
    console.log(`Użytkownik znaleziony: ${!!user}`);

    if (!user) {
      console.log("Nie znaleziono użytkownika z email:", email);
      return res.status(401).json({
        error: "Authentication Failed",
        message: "Invalid email or password",
      });
    }

    console.log("Status konta:", user.status);

    // Sprawdź, czy konto jest aktywne
    if (user.status !== "active") {
      console.log("Konto nieaktywne, status:", user.status);
      return res.status(403).json({
        error: "Authentication Failed",
        message: "Account is inactive or suspended",
      });
    }

    // Sprawdź hasło
    console.log("Sprawdzanie hasła...");
    const isPasswordValid = await user.comparePassword(password);
    console.log(`Hasło poprawne: ${isPasswordValid}`);

    if (!isPasswordValid) {
      console.log("Nieprawidłowe hasło");
      return res.status(401).json({
        error: "Authentication Failed",
        message: "Invalid email or password",
      });
    }

    // Aktualizuj datę ostatniego logowania
    user.lastLogin = new Date();
    await user.save();

    // Wygeneruj token JWT
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRATION }
    );
    console.log("Token wygenerowany pomyślnie");

    // Zwróć token i dane użytkownika
    res.json({
      message: "Login successful",
      token,
      user: user.getProfile(),
    });
  } catch (error) {
    console.error("Szczegóły błędu:", error);
    logger.error(`Błąd podczas logowania: ${error.message}`);
    res.status(500).json({
      error: "Authentication Failed",
      message: "An error occurred during authentication",
    });
  }
};

/**
 * Wylogowuje użytkownika
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const logout = (req, res) => {
  // W przypadku JWT nie ma potrzeby przechowywania tokenów na serwerze
  // Token wygaśnie automatycznie lub klient po prostu przestanie go używać
  res.json({
    message: "Logout successful",
  });
};

/**
 * Pobiera profil zalogowanego użytkownika
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    // Pobierz pełne dane użytkownika
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        error: "Not Found",
        message: "User not found",
      });
    }

    // Zwróć profil użytkownika
    res.json({
      user: user.getProfile(),
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania profilu: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching profile",
    });
  }
};

/**
 * Aktualizuje profil użytkownika
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { firstName, lastName, preferences } = req.body;

    // Pobierz użytkownika
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        error: "Not Found",
        message: "User not found",
      });
    }

    // Aktualizuj dane
    if (firstName !== undefined) user.firstName = firstName;
    if (lastName !== undefined) user.lastName = lastName;

    // Aktualizuj preferencje
    if (preferences) {
      if (preferences.theme) user.preferences.theme = preferences.theme;
      if (preferences.language)
        user.preferences.language = preferences.language;

      if (preferences.notifications) {
        if (preferences.notifications.email) {
          const emailNotifications = preferences.notifications.email;
          if (emailNotifications.enabled !== undefined) {
            user.preferences.notifications.email.enabled =
              emailNotifications.enabled;
          }
          if (emailNotifications.signalAlerts !== undefined) {
            user.preferences.notifications.email.signalAlerts =
              emailNotifications.signalAlerts;
          }
          if (emailNotifications.systemAlerts !== undefined) {
            user.preferences.notifications.email.systemAlerts =
              emailNotifications.systemAlerts;
          }
        }
      }
    }

    // Zapisz zmiany
    await user.save();

    // Zwróć zaktualizowany profil
    res.json({
      message: "Profile updated successfully",
      user: user.getProfile(),
    });
  } catch (error) {
    logger.error(`Błąd podczas aktualizacji profilu: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while updating profile",
    });
  }
};

/**
 * Zmienia hasło użytkownika
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const changePassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    // Sprawdź, czy nowe hasło jest podane
    if (!newPassword) {
      return res.status(400).json({
        error: "Validation Error",
        message: "New password is required",
      });
    }

    // Pobierz użytkownika
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        error: "Not Found",
        message: "User not found",
      });
    }

    // Sprawdź obecne hasło
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(401).json({
        error: "Authentication Failed",
        message: "Current password is incorrect",
      });
    }

    // Ustaw nowe hasło
    user.password = newPassword;
    await user.save();

    res.json({
      message: "Password changed successfully",
    });
  } catch (error) {
    logger.error(`Błąd podczas zmiany hasła: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while changing password",
    });
  }
};

/**
 * Wysyła email z tokenem resetowania hasła
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    // Znajdź użytkownika
    const user = await User.findByEmail(email);
    if (!user) {
      // Ze względów bezpieczeństwa, nie informujemy czy email istnieje
      return res.json({
        message:
          "If your email exists in our system, you will receive a password reset link",
      });
    }

    // Wygeneruj token resetowania hasła
    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000; // Wygasa po 1 godzinie
    await user.save();

    // TODO: Wysłanie emaila z tokenem resetowania hasła
    // W rzeczywistej implementacji, tutaj byłby kod do wysyłania emaila

    // Zwróć sukces
    res.json({
      message:
        "If your email exists in our system, you will receive a password reset link",
    });
  } catch (error) {
    logger.error(`Błąd podczas resetowania hasła: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while processing password reset",
    });
  }
};

/**
 * Resetuje hasło przy użyciu tokenu
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    // Znajdź użytkownika z aktywnym tokenem
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        error: "Invalid Token",
        message: "Password reset token is invalid or has expired",
      });
    }

    // Ustaw nowe hasło
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    // Zwróć sukces
    res.json({
      message: "Password has been reset successfully",
    });
  } catch (error) {
    logger.error(`Błąd podczas resetowania hasła: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while resetting password",
    });
  }
};

/**
 * Weryfikuje token resetowania hasła
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const verifyResetToken = async (req, res) => {
  try {
    const { token } = req.params;

    // Znajdź użytkownika z aktywnym tokenem
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        error: "Invalid Token",
        message: "Password reset token is invalid or has expired",
      });
    }

    // Token jest ważny
    res.json({
      message: "Token is valid",
      email: user.email,
    });
  } catch (error) {
    logger.error(`Błąd podczas weryfikacji tokenu: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while verifying token",
    });
  }
};

/**
 * Pobiera aktualny status autentykacji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getAuthStatus = (req, res) => {
  // Sprawdź, czy token jest obecny w nagłówku
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.json({
      isAuthenticated: false,
    });
  }

  const token = authHeader.split(" ")[1];

  // Spróbuj zweryfikować token
  try {
    jwt.verify(token, JWT_SECRET);
    res.json({
      isAuthenticated: true,
    });
  } catch (error) {
    res.json({
      isAuthenticated: false,
    });
  }
};

module.exports = {
  register,
  login,
  logout,
  getProfile,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyResetToken,
  getAuthStatus,
};
