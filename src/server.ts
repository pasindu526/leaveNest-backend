import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import authRoutes from "./routes/auth";
import userRoutes from "./routes/userRoutes";
import leaveRoutes from "./routes/leaveRequestRoutes";
import notificationRoutes from "./routes/notificationRoutes";

import cron from "node-cron";
import { LeaveRequest } from "./models/LeaveRequest";
import { Notification } from "./models/Notification";
import User from "./models/User";
import nodemailer from "nodemailer";

const cors = require('cors');

dotenv.config();
const app = express();

// Nodemailer transporter (optional, configured via .env)
let transporter: nodemailer.Transporter | null = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  // transporter
  //   .verify()
  //   .then(() => console.log("Mailer verified"))
  //   .catch((err) => console.error("Mailer verification failed:", err));
}

const rawClient = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/+$/, "");
app.use(
  cors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true); // server-to-server or same-origin
      const normalizedConfigured = rawClient.replace(/\/+$/, "");
      try {
        // allow exact configured origin
        if (origin === normalizedConfigured) return callback(null, true);
        const u = new URL(origin);
        // allow main Netlify domain and any preview subdomains like <hash>--leavenest.netlify.app
        if (u.hostname === "leavenest.netlify.app" || u.hostname.endsWith(".leavenest.netlify.app")) {
          return callback(null, true);
        }
      } catch (e) {
        // fallthrough to deny
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/leaverequests", leaveRoutes);
app.use("/api/notifications", notificationRoutes);

mongoose
  .connect(process.env.MONGO_URI!)
  .then(() => {
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => console.log(`Server running on port ${port}`));

    // --- HOURLY REMINDER CRON JOB ---
    cron.schedule("0 * * * *", async () => {
      try {
        // find pending leaves and populate the user (so we can read department)
        const pendingLeaves = await LeaveRequest.find({ status: /pending/i }).populate("user");
        for (const leave of pendingLeaves) {
          // ensure we have a populated user document
          const userDoc = leave.user as any;
          if (!userDoc || !userDoc.department) continue;

          // normalize department string
          const userDept = String(userDoc.department || "").trim();

          // build an hour-based key (YYYYMMDDHH) so reminders are unique per hour/day
          const d = new Date();
          const hourKey =
            `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${String(d.getHours()).padStart(2, "0")}`;

          // find admins either in the same department OR HR admins (case-insensitive)
          const hrRegex = /^(hr|human resources)$/i;
          const admins = await User.find({
            roles: { $in: ["admin"] },
            $or: [{ department: userDept }, { department: { $regex: hrRegex } }],
          });

          for (const admin of admins) {
            // avoid duplicate reminders for the same leave/admin/hour
            const notifId = `reminder_${leave._id}_${admin._id}_${hourKey}`;
            const exists = await Notification.findOne({ notification_id: notifId });
            if (exists) continue;

            await Notification.create({
              notification_id: notifId,
              recipient: admin._id,
              type: "reminder",
              message: `Reminder: Pending leave request from ${userDoc.name || "an employee"}.`,
              status: "unread",
              relatedLeaveRequest: leave._id,
              createdAt: new Date(),
            });

            // send email reminder to admin (non-blocking)
            try {
              const adminEmail = admin.email;
              if (adminEmail) {
                const from = process.env.NO_REPLY_EMAIL || process.env.SMTP_USER || "no-reply@example.com";
                const subject = `Reminder: Pending leave request from ${userDoc.name || "Employee"}`;
                const text = [
                  `You have a pending leave request to review.`,
                  ``,
                  `Employee: ${userDoc.name || "N/A"}`,
                  `Department: ${userDoc.department || "N/A"}`,
                  `Dates: ${Array.isArray(leave.dates) ? leave.dates.join(", ") : leave.dates || "-"}`,
                  `Type: ${leave.leaveType || "-"}`,
                  `Reason: ${leave.reason || "-"}`,
                  ``,
                  `Please review the request in the admin panel.`,
                ].join("\n");

                if (transporter) {
                  await transporter.sendMail({ from, to: adminEmail, subject, text });
                } else {
                  console.log("SMTP not configured — would send reminder:", { from, to: adminEmail, subject, text });
                }
              }
            } catch (mailErr) {
              console.error("Failed to send reminder email:", mailErr);
            }
           }
         }
       } catch (err) {
         console.error("Cron job error:", err);
       }
     });
   })
   .catch((err) => console.log(err));

// create and verify transporter but do NOT crash if verification fails
async function initMailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.log("SMTP not configured, skipping mailer init.");
    (global as any).transporter = null;
    return;
  }

  const tmp = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
  });

  try {
    await tmp.verify();
    (global as any).transporter = tmp;
    console.log("SMTP transporter verified and ready.");
  } catch (err) {
    (global as any).transporter = null;
    console.error("SMTP transporter unavailable — continuing without email. Error:", err && (err as any).message ? (err as any).message : err);
  }
}

// call after process/env and app are ready (eg. after mongoose connect or right after app.listen)
initMailer();
