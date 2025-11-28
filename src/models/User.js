import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  email: { 
    type: String, 
    required: true, 
    unique: true, 
    lowercase: true, 
    index: true 
  },
  name: { 
    type: String 
  },
  passwordHash: { 
    type: String 
  }
}, { timestamps: true });

// Method to hash and set password
userSchema.methods.setPassword = async function setPassword(password) {
  const salt = await bcrypt.genSalt(10);
  this.passwordHash = await bcrypt.hash(password, salt);
};

// Method to validate password
userSchema.methods.validatePassword = async function validatePassword(password) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(password, this.passwordHash);
};

export default mongoose.model('User', userSchema);