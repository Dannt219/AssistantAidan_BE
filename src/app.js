import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { connectMongo } from './config/index.js';
import authRouter from './routes/auth.js';
import generationsRouter from './routes/generations.js';
import { logger } from './utils/logger.js';
import e from 'express';

const app = express();

// CORS configuration
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));

// body parser - parse request body as JSON
app.use(express.json({ limit: '10mb' }));

// Serve uploaded images statically (optional, we also have the route-based approach)
app.use('/uploads', express.static('uploads'));

//HTTP request loging
app.use(morgan('dev'));

// Health check endpoint
app.get('/serverStatus', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'NTDSDET Test Assistant Backend'
    });
});

// Connect to MongoDB
connectMongo().catch(err => {
    logger.error('Failed to connect to MongoDB:', err);
    process.exit(1);
});

// Routes
app.use('/auth', authRouter);
app.use('/generations', generationsRouter);

//Log regitered routes
logger.info('Registered Routes:');
logger.info('POST /auth/register');

// 404 handler - Route not found
app.use((req, res, next) => {
    logger.info(`404 - Not Found: ${req.method} ${req.path}`);
    res.status(404).json({ 
        success: false,
        message: `Route not found: ${req.method} ${req.path}`
    });
});

// Error handler
app.use((err, req, res, next) => {
    const status = err.status || 500;
    logger.error('Error:', err);
    res.status(status).json({ 
        success: false,
        message: err.message || 'Internal Server Error'
    });
});

export default app;