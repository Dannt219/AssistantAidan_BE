import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import sharp from 'sharp';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for memory storage (we'll process images before saving)
const storage = multer.memoryStorage();

// File filter for images only
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Invalid file type. Only ${allowedTypes.join(', ')} are allowed.`), false);
    }
};

// Configure multer
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit per file
        files: 5 // Maximum 5 files per request
    }
});

// Middleware to process uploaded images
export const processImages = async (req, res, next) => {
    if (!req.files || req.files.length === 0) {
        return next();
    }

    try {
        const processedImages = [];

        for (const file of req.files) {
            // Generate unique filename
            const timestamp = Date.now();
            const randomString = Math.random().toString(36).substring(2, 15);
            const filename = `${timestamp}_${randomString}.jpg`;
            const filepath = path.join(uploadsDir, filename);

            // Process image with sharp (compress and convert to JPEG)
            await sharp(file.buffer)
                .jpeg({ quality: 85 }) // Compress to 85% quality
                .resize(1920, 1080, { 
                    fit: 'inside', 
                    withoutEnlargement: true 
                }) // Resize if larger than 1920x1080
                .toFile(filepath);

            // Get image metadata
            const metadata = await sharp(file.buffer).metadata();
            
            const processedImage = {
                originalName: file.originalname,
                filename: filename,
                filepath: filepath,
                mimetype: 'image/jpeg',
                size: fs.statSync(filepath).size,
                originalSize: file.size,
                width: metadata.width,
                height: metadata.height,
                uploadedAt: new Date()
            };

            processedImages.push(processedImage);
            logger.info(`Processed image: ${file.originalname} -> ${filename}`);
        }

        req.processedImages = processedImages;
        next();
    } catch (error) {
        logger.error('Image processing error:', error);
        next(error);
    }
};

// Cleanup function to remove old uploaded files
export const cleanupOldImages = (maxAgeHours = 24) => {
    try {
        const files = fs.readdirSync(uploadsDir);
        const now = Date.now();
        const maxAge = maxAgeHours * 60 * 60 * 1000; // Convert hours to milliseconds

        files.forEach(file => {
            const filepath = path.join(uploadsDir, file);
            const stats = fs.statSync(filepath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                fs.unlinkSync(filepath);
                logger.info(`Cleaned up old image: ${file}`);
            }
        });
    } catch (error) {
        logger.error('Cleanup error:', error);
    }
};

// Export the upload middleware
export const uploadImages = upload.array('images', 5);

export default {
    uploadImages,
    processImages,
    cleanupOldImages
};