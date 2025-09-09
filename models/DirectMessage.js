import mongoose from 'mongoose';

const { Schema } = mongoose;

const DirectMessageSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    coach: { type: Schema.Types.ObjectId, ref: 'Coach', required: true },
    senderType: { type: String, enum: ['user', 'coach'], required: true },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    readByCoach: { type: Boolean, default: false },
    readByUser: { type: Boolean, default: false }
  },
  { timestamps: true }
);

DirectMessageSchema.index({ user: 1, coach: 1, createdAt: 1 });

export default mongoose.models.DirectMessage || mongoose.model('DirectMessage', DirectMessageSchema);

