import express, { Request, Response } from "express";
import User from "../models/User";
import multer from "multer";
import fs from "fs";
import path from "path";

const router = express.Router();

// keep uploads dir creation if other routes use disk storage
const UPLOAD_DIR = path.join(__dirname, "../../uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// use memoryStorage so we can persist file buffer into DB
const storage = multer.memoryStorage();
const upload = multer({ storage });

// --- add helper to produce cache-busted avatar url ---
// now accepts req to build an absolute URL when possible
const avatarUrlFor = (req: Request | null, id: any, hasAvatar: boolean) => {
  if (!hasAvatar) return null;
  if (req && req.get("host")) {
    const proto = req.protocol || "http";
    return `${proto}://${req.get("host")}/api/users/${id}/avatar?t=${Date.now()}`;
  }
  return `/api/users/${id}/avatar?t=${Date.now()}`;
};

// Create a user
router.post("/", upload.single("avatar"), async (req: Request, res: Response) => {
  try {
    // copy body (multipart fields are strings)
    const data: any = { ...req.body };

    // attach avatar if uploaded
    if ((req as any).file) {
      data.avatar = {
        data: (req as any).file.buffer,
        contentType: (req as any).file.mimetype,
      };
    }

    const user = new User(data);
    await user.save();

    const out: any = user.toObject();
    out.avatarUrl = avatarUrlFor(req, user._id, !!user.avatar && !!(user as any).avatar.data);

    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Get all users
router.get("/", async (req: Request, res: Response) => {
  try {
    // by default exclude soft-deleted users; accept ?includeDeleted=true to include them
    const includeDeleted =
      req.query.includeDeleted === "1" ||
      req.query.includeDeleted === "true" ||
      req.query.includeDeleted === "yes";
    const filter = includeDeleted ? {} : { status: { $ne: "user was deleted" } };
    const users = await User.find(filter);
     // include avatarUrl for each user using request host
     const out = users.map((u) => {
       const o: any = (u as any).toObject ? (u as any).toObject() : u;
       o.avatarUrl = avatarUrlFor(req, u._id, !!u.avatar && !!(u as any).avatar?.data);
       return o;
     });
     res.json(out);
   } catch (err) {
     res.status(500).json({ error: (err as Error).message });
   }
 });
 
// PATCH user (partial update; supports setting status for soft-delete)
router.patch("/:userId", upload.single("avatar"), async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    if (!userId) return res.status(400).json({ error: "User id not provided" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // allow updating a small set of fields and status
    const allowed = ["name", "email", "department", "phone", "emp_id", "roles", "status"];
    for (const k of Object.keys(req.body)) {
      if (k.startsWith("_")) continue;
      if (allowed.includes(k)) {
        // cast roles if provided as JSON string
        if (k === "roles" && typeof req.body[k] === "string") {
          try {
            (user as any)[k] = JSON.parse(req.body[k]);
          } catch {
            (user as any)[k] = req.body[k];
          }
        } else {
          (user as any)[k] = req.body[k];
        }
      }
    }

    // handle avatar update / removal if present
    const file = (req as any).file;
    const removeFlag = req.body._removeAvatar === "1" || req.body._removeAvatar === "true";
    if (file) {
      user.avatar = {
        data: file.buffer,
        contentType: file.mimetype,
      } as any;
    } else if (removeFlag) {
      user.avatar = undefined;
    }

    await user.save();
    const out: any = user.toObject();
    out.avatarUrl = avatarUrlFor(req, user._id, !!user.avatar && !!(user as any).avatar?.data);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Delete user by MongoDB _id
router.delete("/:userId", async (req: Request, res: Response) => {
  try {
    // perform soft-delete: set status = "user was deleted"
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.status = "user was deleted";
    await user.save();
    res.json({ message: "User marked as deleted" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
 
// Get user by MongoDB _id
router.get("/:userId", async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.userId).lean();
    if (!user) return res.status(404).json({ error: "User not found" });

    const out = { ...user } as any;
    out.avatarUrl = avatarUrlFor(req, user._id, !!user.avatar && !!(user as any).avatar?.data);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------- NEW: dedicated avatar upload endpoint ----------
router.put(
  "/:userId/avatar",
  upload.single("avatar"),
  async (req: Request, res: Response) => {
    try {
      const userId = req.params.userId;
      if (!userId) return res.status(400).json({ error: "User id not provided" });

      const file = (req as any).file;
      const removeFlag = req.body._removeAvatar === "1" || req.body._removeAvatar === "true";

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      if (file) {
        user.avatar = {
          data: file.buffer,
          contentType: file.mimetype,
        } as any;
      } else if (removeFlag) {
        user.avatar = undefined;
      } else {
        return res.status(400).json({ error: "No avatar file provided" });
      }

      await user.save();

      const out: any = user.toObject();
      out.avatarUrl = avatarUrlFor(req, user._id, !!user.avatar && !!(user as any).avatar?.data);

      res.json(out);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }
);

// Update user by MongoDB _id (accept multipart for avatar)
router.put("/:userId", upload.single("avatar"), async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    if (!userId) return res.status(401).json({ error: "User id not provided" });

    const file = (req as any).file;
    const removeFlag = req.body._removeAvatar === "1" || req.body._removeAvatar === "true";

    // quick debug: log whether file arrived
    // console.log('PUT /users/:userId avatar file present:', !!file, file ? file.originalname : null);

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // update allowed primitive fields from req.body
    const allowed = ["name", "email", "department", "phone", "emp_id", "roles"];
    for (const k of Object.keys(req.body)) {
      if (k.startsWith("_")) continue; // skip control flags
      if (allowed.includes(k)) {
        // cast types if needed (simple assignment)
        (user as any)[k] = req.body[k];
      }
    }

    // handle avatar: new upload or remove
    if (file) {
      user.avatar = {
        data: file.buffer,
        contentType: file.mimetype,
      } as any;
    } else if (removeFlag) {
      user.avatar = undefined;
    }

    await user.save();

    const out: any = user.toObject();
    out.avatarUrl = avatarUrlFor(req, user._id, !!user.avatar && !!(user as any).avatar?.data);

    res.json(out);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Delete user by MongoDB _id
router.delete("/:userId", async (req: Request, res: Response) => {
  try {
    // perform soft-delete: set status = "user was deleted"
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.status = "user was deleted";
    await user.save();
    res.json({ message: "User marked as deleted" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get leave balance for a user by MongoDB _id
router.get("/:userId/leave-balance", async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.userId).select("name leaveBalance");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user.leaveBalance);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get leave balances for all users
router.get('/all/leave-balances', async (_req: Request, res: Response) => {
  const users = await User.find().select("name emp_id leaveBalance");
  res.json(users);
});

// Serve avatar image from DB
router.get("/:userId/avatar", async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.userId).select("avatar");
    if (!user || !user.avatar || !user.avatar.data) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.contentType(user.avatar.contentType || "application/octet-stream");
    res.send(user.avatar.data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
