import { Router } from "express";
import User from "../models/User.js";
import { issueAccessToken, issueRefreshToken } from "../middleware/auth.js";


const router = Router();

// Post /auth/register - register a new user
router.post('/register', async (req, res, next) => {

    try {
        const { email, name, password } = req.body;
        // Check user input
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'User email and password are required'
            });
        }
        // Check if user already exists
        const exists = await User.findOne({ email });
        if (exists) {
            return res.status(400).json({
                success: false,
                error: 'Email already registered'
            });
        }
        const user = new User({ email, name });
        // Hash and set password
        await user.setPassword(password);

        // Save user to database
        await user.save();

        // Generate tokens
        const accessToken = issueAccessToken(user);
        const refreshToken = issueRefreshToken(user);

        // Return success response with tokens
        return res.json({
            success: true,
            data: {
                accessToken,
                refreshToken,
                user: {
                    id: user._id,
                    email: user.email,
                    name: user.name
                }
            }
        });
    } catch (e) {
        next(e)
    }
});


// Post /auth/login
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'User email and password are required'
            })
        }
        const user = await User.findOne({ email });
        if (!user || !(await user.validatePassword(password))) {
            return res.status(401).json({
                success: false,
                error: 'Invalid credentials'
            });
        }

        const accessToken = issueAccessToken(user);
        const refreshToken = issueRefreshToken(user);
        return res.json({
            success: true,
            data: {
                accessToken,
                refreshToken,
                user: {
                    id: user._id,
                    email: user.email,
                    name: user.name
                }
            }
        })
    } catch (error) {
        next(error)
    }
});
export default router;