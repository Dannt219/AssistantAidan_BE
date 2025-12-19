import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory storage for image sessions (in production, use Redis or database)
const imageSessions = new Map();

// Session timeout (30 minutes)
const SESSION_TIMEOUT = 30 * 60 * 1000;

export class ImageSessionManager {
    static generateSessionId() {
        return `img_session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    }

    static createSession(userEmail, images) {
        const sessionId = this.generateSessionId();
        const session = {
            id: sessionId,
            userEmail,
            images,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + SESSION_TIMEOUT)
        };

        imageSessions.set(sessionId, session);
        logger.info(`Created image session ${sessionId} for user ${userEmail} with ${images.length} images`);

        // Auto cleanup after timeout
        setTimeout(() => {
            this.cleanupSession(sessionId);
        }, SESSION_TIMEOUT);

        return sessionId;
    }

    static getSession(sessionId, userEmail = null) {
        const session = imageSessions.get(sessionId);
        
        if (!session) {
            return null;
        }

        // Check if session expired
        if (new Date() > session.expiresAt) {
            this.cleanupSession(sessionId);
            return null;
        }

        // Check user ownership if provided
        if (userEmail && session.userEmail !== userEmail) {
            return null;
        }

        return session;
    }

    static cleanupSession(sessionId) {
        const session = imageSessions.get(sessionId);
        if (!session) return;

        // Delete physical files
        session.images.forEach(image => {
            try {
                if (fs.existsSync(image.filepath)) {
                    fs.unlinkSync(image.filepath);
                    logger.info(`Cleaned up session image: ${image.filename}`);
                }
            } catch (error) {
                logger.warn(`Failed to cleanup session image ${image.filename}: ${error.message}`);
            }
        });

        // Remove from memory
        imageSessions.delete(sessionId);
        logger.info(`Cleaned up image session: ${sessionId}`);
    }

    static extendSession(sessionId, userEmail) {
        const session = this.getSession(sessionId, userEmail);
        if (!session) return false;

        session.expiresAt = new Date(Date.now() + SESSION_TIMEOUT);
        logger.info(`Extended image session: ${sessionId}`);
        return true;
    }

    static getAllUserSessions(userEmail) {
        const userSessions = [];
        for (const [sessionId, session] of imageSessions.entries()) {
            if (session.userEmail === userEmail && new Date() <= session.expiresAt) {
                userSessions.push({
                    sessionId,
                    imageCount: session.images.length,
                    createdAt: session.createdAt,
                    expiresAt: session.expiresAt
                });
            }
        }
        return userSessions;
    }

    static cleanupExpiredSessions() {
        const now = new Date();
        const expiredSessions = [];

        for (const [sessionId, session] of imageSessions.entries()) {
            if (now > session.expiresAt) {
                expiredSessions.push(sessionId);
            }
        }

        expiredSessions.forEach(sessionId => {
            this.cleanupSession(sessionId);
        });

        if (expiredSessions.length > 0) {
            logger.info(`Cleaned up ${expiredSessions.length} expired image sessions`);
        }

        return expiredSessions.length;
    }
}

// Periodic cleanup every 10 minutes
setInterval(() => {
    ImageSessionManager.cleanupExpiredSessions();
}, 10 * 60 * 1000);

export default ImageSessionManager;