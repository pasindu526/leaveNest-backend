import express, { Request, Response } from 'express';
import { Notification } from '../models/Notification';
import User from '../models/User';

const router = express.Router();

// Create notification
router.post('/', async (req: Request, res: Response) => {
  try {
    const notification = new Notification(req.body);
    await notification.save();
    res.status(201).json(notification);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Get all notifications
// router.get('/', async (_req: Request, res: Response) => {
//   try {
//     const notifications = await Notification.find().populate('recipient sender relatedLeaveRequest');
//     res.json(notifications);
//   } catch (err) {
//     res.status(500).json({ error: (err as Error).message });
//   }
// });
router.get('/', async (req: Request, res: Response) => {
  try {
    const { recipient, role, department } = req.query;
    let filter: any = {};

    if (recipient) {
      filter.recipient = recipient;
    } else if (role && department) {
      // Find all users with this role and department
      const users = await User.find({ roles: role, department });
      const userIds = users.map(u => u._id);
      filter.recipient = { $in: userIds };
    }

    const notifications = await Notification.find(filter)
      .populate('recipient sender relatedLeaveRequest')
      .sort({ createdAt: -1 });
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const notification = await Notification.findById(req.params.id).populate('recipient sender relatedLeaveRequest');
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    res.json(notification);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Mark as read
router.put('/:id/read', async (req: Request, res: Response) => {
  try {
    const updated = await Notification.findByIdAndUpdate(req.params.id, {
      isRead: true,
      status: 'read',
    }, { new: true });
    if (!updated) return res.status(404).json({ error: 'Notification not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
