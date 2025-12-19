#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

import { cleanupOldImages } from '../middleware/upload.js';
import { logger } from '../utils/logger.js';

// Cleanup images older than 24 hours by default
const maxAgeHours = parseInt(process.argv[2]) || 24;

logger.info(`Starting image cleanup for files older than ${maxAgeHours} hours...`);

try {
    cleanupOldImages(maxAgeHours);
    logger.info('Image cleanup completed successfully');
    process.exit(0);
} catch (error) {
    logger.error('Image cleanup failed:', error);
    process.exit(1);
}