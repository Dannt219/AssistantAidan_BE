import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import app from './app.js';
import { logger } from './utils/logger.js';

const PORT = process.env.PORT || 3000;
const server = createServer(app);

server.listen(PORT, () => {
    logger.info(`🚀 Server is running on http://localhost:${PORT}`);
    logger.info(`🌐 Health check: http://localhost:${PORT}/serverStatus`);
});