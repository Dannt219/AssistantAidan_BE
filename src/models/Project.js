import mongoose from "mongoose";


const projectSchema = new mongoose.Schema({
    projectKey: {
        type: String,
        require: true,
        unique: true,
        upercase: true,
        index: true
    },
    name: {
        type: String,
        default: null
    },
    description: {
        type: String,
        default: null
    },
    firstGeneratedAt: { type: Date },
    lastGeneratedAt: { type: Date },
    totalGenerations: { type: Number, default: 0 },
    createdby: { type: String }
}, { timestamps: true });

export default mongoose.model('Project', projectSchema)