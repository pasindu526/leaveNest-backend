import mongoose, { Schema, Document, Types } from 'mongoose';

export interface INotification extends Document {
  notification_id: string;
  recipient: Types.ObjectId;
  sender?: Types.ObjectId;
  // include 'reminder' for cron-generated reminders
  type: 'leave_submitted' | 'leave_approved' | 'leave_rejected' | 'general' | 'reminder';
  message: string;
  status: 'unread' | 'read';
  isRead?: boolean;
  relatedLeaveRequest?: Types.ObjectId;
}

const notificationSchema = new Schema<INotification>({
  notification_id: { type: String, required: true, unique: true },
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  sender: { type: Schema.Types.ObjectId, ref: 'User' },
  type: {
    type: String,
    // added 'reminder' so cron-created notifications validate
    enum: ['leave_submitted', 'leave_approved', 'leave_rejected', 'general', 'reminder'],
    required: true
  },
  message: { type: String, required: true },
  status: {
    type: String,
    enum: ['unread', 'read'],
    default: 'unread'
  },
  isRead: { type: Boolean, default: false },
  relatedLeaveRequest: { type: Schema.Types.ObjectId, ref: 'LeaveRequest' }
}, { timestamps: true });

export const Notification = mongoose.model<INotification>('Notification', notificationSchema);
export default Notification;
