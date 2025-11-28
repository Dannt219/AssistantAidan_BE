import jwt from 'jsonwebtoken';
import { jwtConfig } from '../config/index.js';

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