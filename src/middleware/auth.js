import jwt from 'jsonwebtoken';
import { jwtConfig } from '../config/index.js';

export function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer') ? header.slice(7) : null;
    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Missing token'
        })
    };
    try {
        const payload = jwt.verify(token, jwtConfig.secret);
        req.user = { userId: payload.sub, email: payload.email, name: payload.name };
        return next();
    } catch (e) {
        return res.status(401).json({ success: false, error: 'Invalid token' });
    }
}

//function to issue access token
export function issueAccessToken(user) {
    return jwt.sign(
        {
            sub: String(user._id),
            email: user.email,
            mame: user.name
        },
        jwtConfig.secret,
        {
            expiresIn: jwtConfig.accessTokenTtlSec
        }
    );
}

//function to issue refresh token
export function issueRefreshToken(user) {
    return jwt.sign(
        {
            sub: String(user._id),
            type: 'refresh'
        },
        jwtConfig.secret,
        {
            expiresIn: jwtConfig.refreshTokenTtlSec
        }
    );
}