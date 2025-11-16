import express, { Request, Response } from "express";
import multer from "multer";
import dotenv from "dotenv";
import crypto from "crypto";
import { LeaveRequest } from "../models/LeaveRequest";
import { v4 as uuidv4 } from 'uuid';
import { Notification } from '../models/Notification';
import User from '../models/User';
import nodemailer from 'nodemailer';
import { sendMail } from "../utils/mailer";

// Configure environment variables
dotenv.config();

// use a safe fallback so missing env doesn't throw at module load
const ENCRYPTION_KEY = (process.env.DOC_ENCRYPTION_KEY || "").padEnd(32, "0").slice(0, 32);
const IV_LENGTH = 16;

// Encryption helpers
function encrypt(buffer: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

function decrypt(buffer: Buffer): Buffer {
  const iv = buffer.slice(0, IV_LENGTH);
  const encryptedText = buffer.slice(IV_LENGTH);
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), iv);
  return Buffer.concat([decipher.update(encryptedText), decipher.final()]);
}

// Multer for in-memory storage
const upload = multer();

const router = express.Router();

// --- Utility function to update leave balance ---
async function updateLeaveBalance(userId: string, leaveRequest: any) {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  let annual = user.leaveBalance.annual;
  let medical = user.leaveBalance.medical;
  let shortleave = user.leaveBalance.shortleave;
  let leavesTaken = user.leaveBalance.leavesTaken || 0;

  const leaveType = leaveRequest.leaveType;
  const reason = leaveRequest.reason;
  const dates = Array.isArray(leaveRequest.dates) ? leaveRequest.dates : [];

  if (leaveType === "Full Day") {
    if (reason === "Sick") {
      medical -= dates.length;
      leavesTaken += dates.length;
    } else {
      annual -= dates.length;
      leavesTaken += dates.length;
    }
  } else if (leaveType === "Short Leave") {
    shortleave -= dates.length * 0.5;
    leavesTaken += dates.length * 0.5;
  }

  // Prevent negative balances
  annual = Math.max(0, annual);
  medical = Math.max(0, medical);
  shortleave = Math.max(0, shortleave);

  user.leaveBalance.annual = annual;
  user.leaveBalance.medical = medical;
  user.leaveBalance.shortleave = shortleave;
  user.leaveBalance.leavesTaken = leavesTaken;

  await user.save();
}

// Consolidated helper to notify the leave requester when status changes
async function notifyRequesterOfStatusChange(leave: any, approverId: any, newStatus: string) {
  try {
    // effectiveApproverId: prefer explicit approverId, then leave.approver (which might be populated doc or id)
    const effectiveApproverId =
      approverId ||
      (leave.approver ? (typeof leave.approver === "object" ? (leave.approver._id || leave.approver) : leave.approver) : null);

    const statusLower = newStatus.toLowerCase();
    const basicMessage =
      statusLower === "approved"
        ? "Your leave request has been approved"
        : `Your leave request has been ${statusLower}`;

    const recipientId = leave.user || leave.requester || leave.employee;
    const recipientUser = recipientId ? await User.findById(recipientId) : null;

    // Resolve approver: if leave.approver is a populated object use it; otherwise fetch by id
    let approverUser: any | null = null;
    if (leave.approver && typeof leave.approver === "object" && (leave.approver._id || leave.approver.email)) {
      approverUser = leave.approver;
    } else if (effectiveApproverId) {
      approverUser = await User.findById(effectiveApproverId);
    }

    const approverName = approverUser?.name ?? null;
    const message = approverName ? `${basicMessage} by ${approverName}.` : basicMessage;

    const senderValue = approverUser ? approverUser._id : effectiveApproverId || null;

    const notif = new Notification({
      notification_id: uuidv4(),
      recipient: recipientId,
      sender: senderValue,
      type: statusLower === "approved" ? "leave_approved" : "leave_rejected",
      message,
      status: "unread",
      isRead: false,
      relatedLeaveRequest: leave._id,
    });

    await notif.save();

    // Optionally send an email using approver email as sender when available
    const recipientEmail = recipientUser?.email;
    const senderEmail = approverUser?.email || process.env.NO_REPLY_EMAIL;
    if (recipientEmail && senderEmail) {
      try {
        // use verified global transporter only; do not create new transports here
        const activeTransporter = (global as any).transporter as nodemailer.Transporter | null;
        if (!activeTransporter) {
          console.log("SMTP not available; skipping status email to", recipientEmail);
        } else {
          const mailOptions = {
            from: `${approverName || "AIOH Admin"} <${senderEmail}>`,
            to: recipientEmail,
            subject: `Leave request ${newStatus}`,
            text: [
              message,
              "",
              `Request details:`,
              `- Type: ${leave.leaveType || ""}`,
              `- Dates: ${Array.isArray(leave.dates) ? leave.dates.join(", ") : leave.dates || ""}`,
              `- Reason: ${leave.reason || ""}`,
            ].join("\n"),
            html: [
              `<p>${message}</p>`,
              `<p><strong>Request details:</strong></p>`,
              `<ul>`,
              `<li>Type: ${leave.leaveType || ""}</li>`,
              `<li>Dates: ${Array.isArray(leave.dates) ? leave.dates.join(", ") : leave.dates || ""}</li>`,
              `<li>Reason: ${leave.reason || ""}</li>`,
              `</ul>`,
            ].join(""),
          };
          // send via wrapper (SendGrid preferred); errors are caught by outer try/catch
          try {
            await sendMail({
              from: mailOptions.from,
              to: mailOptions.to,
              subject: mailOptions.subject,
              text: mailOptions.text,
              html: mailOptions.html,
            });
          } catch (e) {
            console.error("Failed sending status email (wrapper):", e);
          }
        }
      } catch (emailErr) {
        console.error("Failed to send status email to requester", emailErr);
      }
    }
  } catch (err) {
    console.error("Failed to create notification for requester", err);
  }
}

// Create leave request with encrypted proof document
router.post('/', upload.single("proofDocument"), async (req: Request, res: Response) => {
  try {
    const {
      user,
      leaveType,
      dates,
      reason,
      halfDayType,
      otherReason,
    } = req.body;

    let leaveDates: string[] = [];
    if (Array.isArray(dates)) {
      leaveDates = dates;
    } else if (dates) {
      leaveDates = [dates];
    }

    if (!user || !leaveType || !leaveDates.length) {
      return res.status(400).json({ error: "Required fields missing" });
    }

    const finalReason = reason === "Other" && otherReason ? otherReason : reason;

    let proofDocument, proofDocumentMimeType;
    if (req.file) {
      proofDocument = encrypt(req.file.buffer);
      proofDocumentMimeType = req.file.mimetype;
    }

    const request = new LeaveRequest({
      user,
      leaveType,
      dates: leaveDates,
      reason: finalReason,
      halfDayType,
      proofDocument,
      proofDocumentMimeType,
    });
    await request.save();

    // Populate user to access department and name
    await request.populate('user');
    const userDoc = (request.user && typeof request.user === "object" && "department" in request.user)
      ? request.user as { _id: any; name?: string; department?: string }
      : null;

    const userDepartment = userDoc?.department;

    // Find a single admin in the same department. If none, fall back to one HR admin.
    const adminDeptRegex = /(hr|human resources)/i;
    // Try to pick one admin from the same department
    let targetAdmin = await User.findOne({ roles: "admin", department: userDepartment }).sort({ createdAt: 1 });
    // If none in department, pick one HR admin as a single fallback so HR still sees the request
    if (!targetAdmin) {
      targetAdmin = await User.findOne({ roles: "admin", department: { $regex: adminDeptRegex } }).sort({ createdAt: 1 });
    }

    if (targetAdmin) {
      try {
        const notifId = `leave_${request._id}_${targetAdmin._id}`;
        const exists = await Notification.findOne({
          notification_id: notifId,
          recipient: targetAdmin._id,
          relatedLeaveRequest: request._id,
        });
        if (!exists) {
          await Notification.create({
            notification_id: notifId,
            recipient: targetAdmin._id,
            sender: userDoc?._id,
            type: "leave_submitted",
            message: `New leave request from ${userDoc?.name || "an employee"}.`,
            status: "unread",
            relatedLeaveRequest: request._id,
            createdAt: new Date(),
          });

          // prepare mail options (do NOT await sendMail on the main request path)
          const adminEmail = (targetAdmin as any).email;
          if (adminEmail) {
            const mailOptions = {
              from: process.env.NO_REPLY_EMAIL || process.env.SMTP_USER || "no-reply@example.com",
              to: adminEmail,
              subject: `New leave request from ${userDoc?.name || "employee"}`,
              text: [
                `A new leave request has been submitted.`,
                "",
                `Employee: ${userDoc?.name || "N/A"}`,
                `Department: ${userDoc?.department || "N/A"}`,
                `Dates: ${Array.isArray(leaveDates) ? leaveDates.join(", ") : leaveDates}`,
                `Type: ${leaveType}`,
                `Reason: ${finalReason}`,
                "",
                `View in admin panel to approve or reject.`,
              ].join("\n"),
            };

            // send in background via sendMail wrapper (prefers SendGrid, falls back to nodemailer)
            (async () => {
              try {
                await sendMail({
                  from: mailOptions.from,
                  to: mailOptions.to,
                  subject: mailOptions.subject,
                  text: mailOptions.text,
                });
              } catch (err) {
                console.error("Background email error (admin):", err);
              }
            })();
          }
        }
      } catch (err) {
        console.error("Failed to notify admin", targetAdmin?._id || targetAdmin, err);
      }
    } else {
      console.warn("No admin found to notify for department:", userDepartment);
    }

    // send response before any potentially slow background work
    res.status(201).json(request);
  } catch (err) {
    console.error("LEAVE REQUEST ERROR:", err);
    res.status(400).json({ error: (err as Error).message });
  }
});

// Route to serve decrypted proof document
router.get('/:id/proof', async (req, res) => {
  const leave = await LeaveRequest.findById(req.params.id);
  if (!leave || !leave.proofDocument) return res.status(404).send("Not found");
  const decrypted = decrypt(leave.proofDocument);
  res.set("Content-Type", leave.proofDocumentMimeType || "application/octet-stream");
  res.send(decrypted);
});

// Get all leave requests
router.get('/', async (_req: Request, res: Response) => {
  try {
    const requests = await LeaveRequest.find().populate('user approver');
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get leave request by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const request = await LeaveRequest.findById(req.params.id).populate('user approver');
    if (!request) return res.status(404).json({ error: 'Leave request not found' });
    res.json(request);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Delete leave request
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await LeaveRequest.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Leave request not found' });
    res.json({ message: 'Leave request deleted' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Update leave request (e.g., approve/reject) and update balance if approved
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const updated = await LeaveRequest.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ error: 'Leave request not found' });

    if (req.body.status === "Approved") {
      await updateLeaveBalance(updated.user.toString(), updated);
    }

    // derive approver id: prefer authenticated admin (req.user), then any approverId in body
    const approverId = (req as any).user?._id?.toString() || req.body.approverId || null;

    // save approver on the leave record when available (approver is admin._id)
    if (approverId) {
      updated.approver = approverId;
      await updated.save();
    }

    // final fallback: use updated.approver if approverId wasn't provided
    const finalApproverId = approverId || (updated.approver ? (updated.approver._id || updated.approver) : null);

    if (req.body.status) {
      try {
        await notifyRequesterOfStatusChange(updated, finalApproverId, req.body.status);
      } catch (e) {
        console.error('Failed to notify requester:', e);
      }
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Example: inside your existing route that changes status (update to match your route)
router.put('/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // e.g. "Approved" or "Rejected"
    const updated = await LeaveRequest.findByIdAndUpdate(id, { status }, { new: true });
    if (!updated) return res.status(404).json({ error: 'Leave not found' });

    const approverId = (req as any).user?._id?.toString() || req.body.approverId || null;

    if (req.body.status === "Approved") {
      await updateLeaveBalance(updated.user.toString(), updated);
    }

    // save approver on the leave record when available (approver is admin._id)
    if (approverId) {
      updated.approver = approverId;
      await updated.save();
    }

    // final fallback: use updated.approver if approverId wasn't provided
    const finalApproverId = approverId || (updated.approver ? (updated.approver._id || updated.approver) : null);

    if (req.body.status) {
      try {
        await notifyRequesterOfStatusChange(updated, finalApproverId, req.body.status);
      } catch (e) {
        console.error('Failed to notify requester:', e);
      }
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;