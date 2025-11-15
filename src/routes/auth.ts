import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User";

const router = express.Router();

// Register user
router.post("/register", async (req, res) => {
  try {
    const { emp_id, name, email, password, department, roles } = req.body;

    const existing = await User.findOne({ emp_id });
    if (existing) return res.status(400).json({ msg: "Employee already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      emp_id,
      name,
      email,
      password: hashedPassword,
      roles,
      department,
    });

    await newUser.save();
    res.status(201).json({ msg: "User registered successfully" });
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

// Login with emp_id
router.post("/login", async (req, res) => {
  try {
    const { emp_id, password } = req.body;

    const user = await User.findOne({ emp_id });
    if (!user) return res.status(404).json({ msg: "Employee not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    // Generate JWT
    const token = jwt.sign({ id: user._id, emp_id: user.emp_id }, process.env.JWT_SECRET!, {
      expiresIn: "1d",
    });

    res.json({
      token,
      user: {
        id: user._id,
        emp_id: user.emp_id,
        name: user.name,
        email: user.email,
        roles: user.roles,
        department: user.department,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

// inline authenticate middleware — reuse existing file (no new files)
const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = (req.headers.authorization || req.headers.Authorization) as string | undefined;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET as string) as any;
    // attach user id to request
    (req as any).userId = payload?.id || payload?._id;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// ---------- change-password (authenticated) ----------
router.post("/change-password", authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Both current and new passwords are required" });
    }
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }

    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ error: "Current password is incorrect" });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ msg: "Password changed successfully" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
