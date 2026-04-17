const mongoose = require('mongoose');

const adminUserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  role: { type: String, enum: ['superadmin', 'admin'], default: 'admin' },
  createdAt: { type: Date, default: Date.now },
});
adminUserSchema.index({ email: 1 }, { unique: true });

module.exports = mongoose.model('AdminUser', adminUserSchema, 'admin_users');
