import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ILeaveRequest extends Document {
  user: Types.ObjectId;
  leaveType: 'annual' | 'medical' | 'shortleave' | 'halfday';
  dates: Date[];
  reason: string;
  halfDayType?: 'morning' | 'afternoon';
  proofDocument?: Buffer;
  proofDocumentMimeType?: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  approver?: Types.ObjectId;
  comments?: string[];
}

const leaveRequestSchema = new Schema<ILeaveRequest>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  leaveType: { type: String, enum: ["Full Day", "Half Day", "Short Leave"], required: true },
  dates: [{ type: Date, required: true }],
  reason: { type: String, required: true },
  halfDayType: { type: String, enum: ["morning", "afternoon"], required: false },
  proofDocument: { type: Buffer },
  proofDocumentMimeType: { type: String },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected'],
    default: 'Pending'
  },
  approver: { type: Schema.Types.ObjectId, ref: 'User' },
  comments: [{ type: String }]
}, { timestamps: true });

export const LeaveRequest = mongoose.model<ILeaveRequest>('LeaveRequest', leaveRequestSchema);
