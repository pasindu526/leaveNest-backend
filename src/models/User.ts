import mongoose, { Schema, Document } from "mongoose";

interface IUser extends Document {
  emp_id: string;
  name: string;
  email: string;
  password: string;
  roles: ("employee" | "admin")[];
  department: string;
  // adminPermissions?: ("approve_requests" | "reject_requests")[];
  leaveBalance: {
    annual: number;
    medical: number;
    shortleave: number;
    leavesTaken: number;
  };
  avatar?: {
    data: Buffer;
    contentType: string;
  };
  status?: string; // e.g. "active" | "user was deleted"
}

const UserSchema: Schema = new Schema({
  emp_id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  roles: { type: [String]},
  department: { type: String, required: true },
  // adminPermissions: [{ type: String }],
  leaveBalance: {
    annual: { type: Number, default: 20 },
    medical: { type: Number, default: 4 },
    shortleave: { type: Number, default: 24 },
    leavesTaken: { type: Number, default: 0 },
  },
  avatar: {
    data: Buffer,
    contentType: String,
  },
  // soft-delete status field; default active
  status: { type: String, default: "active" },
});
 
export default mongoose.model<IUser>("User", UserSchema);
