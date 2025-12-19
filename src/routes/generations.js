import { Router } from "express";
import JiraService from '../services/jiraService.js'
import { requireAuth } from "../middleware/auth.js";
import { uploadImages, processImages, cleanupOldImages } from "../middleware/upload.js";
import { logger } from "../utils/logger.js";
import OpenAIService from "../services/openAiService.js";
import Generation from '../models/Generation.js'
import { extractProject, findOrCreateProject } from '../utils/projectUtils.js'
import { generateExcelBuffer } from '../services/excelService.js';
import fs from 'fs';
import path from 'path';

const router = Router();
let jiraService = null;
let openAiService = null;
export function getJiraService() {
    if (!jiraService) {
        try {
            jiraService = new JiraService();
        } catch (error) {
            throw new Error('JIRA service not configured. Please set JIRA_EMAIL and JIRA_API_TOKEN in .env');
        }
    }
    return jiraService
}

export function getOpenAiService() {
    if (!openAiService) {
        try {
            openAiService = new OpenAIService();
        } catch (err) {
            throw new Error(err.message);
        }
    }
    return openAiService
}

router.post('/prelight', requireAuth, async (req, res, next) => {
    const { issueKey } = req.body;
    if (!issueKey) {
        return res.status(400).json({ success: false, error: 'issueKey required' });
    }
    const jira = getJiraService();
    const issueResult = await jira.getIssue(issueKey);
    if (!issueResult.success) {
        // Return appropriate status code based on error type
        const statusCode = issueResult.error.includes('authentication') || issueResult.error.includes('forbidden')
            ? 401
            : issueResult.error.includes('not found')
                ? 404
                : 500;
        return res.status(statusCode).json({ success: false, error: issueResult.error || 'Issue not found in JIRA' });
    }
    const issue = issueResult.issue;
    const fields = issue.fields;
    const summary = fields.summary || '';
    const description = jira.extractTextFromADF(fields.description) || '';
    logger.info(`Issue ${issueKey} description: `, description)

    // Count attachments
    const attachments = fields.attachment || [];
    const imageAttachments = attachments.filter(att => att.mimeType?.startsWith('image/'));

    // UI detection: use improved keyword analysis + OpenAI
    // const openai = getOpenAIService();
    // const openaiCheckFn = async (context) => {
    //     return await openai.checkIfUiStory(context);
    // };

    // const isUiStory = await checkIfUiStory(issue, openaiCheckFn, jira.extractTextFromADF.bind(jira));
    // logger.info(`UI detection for ${issueKey}: ${isUiStory ? 'UI story' : 'Not UI story'}`);

    // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
    const contextText = `${summary} ${description}`;
    const contextLength = contextText.length;
    const baseTokens = Math.ceil(contextLength / 4);
    const imageTokens = imageAttachments.length * 1000; // ~1000 tokens per image for vision model
    const estimatedTokens = baseTokens + imageTokens;

    // Estimate cost - use vision model pricing if images are present
    let estimatedCost;
    if (imageAttachments.length > 0) {
        // gpt-4o pricing: $2.50/1M input tokens, $10.00/1M output tokens
        estimatedCost = (estimatedTokens / 1000000) * 2.50 + (8000 / 1000000) * 10.00;
    } else {
        // gpt-4o-mini pricing: $0.15/1M input tokens, $0.60/1M output tokens
        estimatedCost = (estimatedTokens / 1000000) * 0.15 + (8000 / 1000000) * 0.60;
    }

    // return prelight data
    return res.json({
        isUiStory: true,
        issueKey,
        title: summary || 'N/A',
        description,
        attachments: attachments.length,
        estimatedTokens,
        estimatedCost: estimatedCost.toFixed(4)
    })

    // Check for existing generations with the same issueKey (case-insensitive)
    const normalizedIssueKey = issueKey.trim();
    const issueKeyRegex = new RegExp(`^${normalizedIssueKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

    // First, check for published generations (visible to all users)
    // const existingPublished = await Generation.findOne({
    //     issueKey: issueKeyRegex,
    //     published: true,
    //     status: 'completed'
    // }).sort({ createdAt: -1 }); // Get the most recent one
})



router.post('/testcases', requireAuth, uploadImages, processImages, async (req, res, next) => {
    try {
        const { issueKey, async: isAsync = false, autoMode = false } = req.body || {};
        if (!issueKey) {
            return res.status(400).json({ success: false, error: 'issueKey required' });
        }

        // Use uploaded images directly
        const uploadedImages = req.processedImages || [];
        if (uploadedImages.length > 0) {
            logger.info(`Using ${uploadedImages.length} uploaded images for generation`);
        }

        // Extract project key and find/create project
        const projectKey = extractProject(issueKey);
        let project = null;

        if (projectKey) {
            try {
                project = await findOrCreateProject(projectKey, req.user.email);
                logger.info(`Associated generation with project: ${projectKey}`);
            } catch (projectError) {
                logger.warn(`Failed to find/create project ${projectKey}: ${projectError.message}. Continuing without project.`);
            }
        }

        // Create generation document
        const generation = new Generation({
            issueKey,
            email: req.user.email,
            project: project ? project._id : undefined,
            mode: autoMode ? 'auto' : 'manual',
            status: isAsync ? 'queued' : 'running',
            startedAt: isAsync ? undefined : new Date(),
            images: uploadedImages || []
        });
        await generation.save();

        // Update project stats
        if (project) {
            const Project = (await import('../models/Project.js')).default;
            const updatedProject = await Project.findById(project._id);
            if (updatedProject) {
                updatedProject.totalGenerations = await Generation.countDocuments({ project: project._id });
                await updatedProject.save();
            }
        }

        // Handle async mode
        if (isAsync) {
            return res.json({
                success: true,
                data: {
                    generationId: String(generation._id),
                    status: 'queued'
                }
            });
        }

        // Sync: Fetch JIRA data and generate
        const startTime = Date.now();

        // Fetch issue from JIRA
        const jira = getJiraService();
        const issueResult = await jira.getIssue(issueKey);

        if (!issueResult.success) {
            generation.status = 'failed';
            generation.error = issueResult.error || 'Failed to fetch JIRA issue';
            generation.completedAt = new Date();
            await generation.save();
            return res.status(404).json({ success: false, error: issueResult.error });
        }

        const issue = issueResult.issue;
        const fields = issue.fields;

        // Build context from JIRA issue data
        const summary = fields.summary || '';
        const description = jira.extractTextFromADF(fields.description) || '';

        // Extract acceptance criteria
        let acceptanceCriteria = '';
        if (fields.customfield_10026) {
            acceptanceCriteria = jira.extractTextFromADF(fields.customfield_10026) || '';
        } else if (fields.customfield_10016) {
            acceptanceCriteria = jira.extractTextFromADF(fields.customfield_10016) || '';
        }

        // Build context string
        const context = `Title: ${summary}

Description:
${description}

${acceptanceCriteria ? `Acceptance Criteria:\n${acceptanceCriteria}` : ''}`;

        // Generate test cases using OpenAI
        let markdownContent;
        let tokenUsage = null;
        let cost = null;

        try {
            const openai = getOpenAiService();

            logger.info(`Generating test cases with OpenAI (mode: ${autoMode ? 'auto' : 'manual'}) with ${uploadedImages.length} image(s)`);
            const result = await openai.generateTestCases(context, issueKey, autoMode, uploadedImages);

            // Handle response format
            if (typeof result === 'string') {
                markdownContent = result;
            } else {
                markdownContent = result.content;
                tokenUsage = result.tokenUsage;
                cost = result.cost;
            }

            // Ensure we have a proper title
            if (!markdownContent.startsWith('#')) {
                markdownContent = `# Test Cases for ${issueKey}: ${summary || 'Untitled'}\n\n${markdownContent}`;
            }
        } catch (error) {
            logger.error(`OpenAI generation failed: ${error.message}`);
            generation.status = 'failed';
            generation.error = `OpenAI generation failed: ${error.message}`;
            generation.completedAt = new Date();
            await generation.save();
            return res.status(500).json({ success: false, error: error.message || 'Failed to generate test cases' });
        }

        // Calculate generation time
        const generationTimeSeconds = (Date.now() - startTime) / 1000;

        // Update generation document
        generation.status = 'completed';
        generation.completedAt = new Date();
        generation.generationTimeSeconds = Math.round(generationTimeSeconds * 100) / 100;
        generation.cost = cost;
        generation.tokenUsage = tokenUsage;
        generation.result = {
            markdown: {
                filename: `${issueKey}_testcases_${generation._id}.md`,
                content: markdownContent
            }
        };
        generation.currentVersion = 1;
        generation.versions = [];

        await generation.save();

        // Return success response
        logger.info({
            success: true,
            data: {
                generationId: String(generation._id),
                issueKey,
                markdown: generation.result.markdown,
                generationTimeSeconds: generation.generationTimeSeconds,
                cost: generation.cost
            }
        })
        return res.json({
            success: true,
            data: {
                generationId: String(generation._id),
                issueKey,
                markdown: generation.result.markdown,
                generationTimeSeconds: generation.generationTimeSeconds,
                cost: generation.cost,
                imagesUsed: uploadedImages ? uploadedImages.length : 0
            }
        });
    } catch (e) {
        // Clean up uploaded images if generation failed
        if (req.processedImages) {
            req.processedImages.forEach(img => {
                try {
                    if (fs.existsSync(img.filepath)) {
                        fs.unlinkSync(img.filepath);
                        logger.info(`Cleaned up failed generation image: ${img.filename}`);
                    }
                } catch (cleanupError) {
                    logger.warn(`Failed to cleanup image ${img.filename}: ${cleanupError.message}`);
                }
            });
        }
        next(e);
    }
});

router.get('/:id/view', requireAuth, async (req, res, next) => {
    try {
        const gen = await Generation.findById(req.params.id)
        if (!gen) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        const isOwner = gen.email === req.user.email;
        const isPublisAndCompleted = gen.published && gen.status === 'completed';

        if (!isOwner && !isPublisAndCompleted) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        if (gen.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Generation not completed yet' });
        }

        const latestVersion = gen.versions && gen.versions.length > 0
            ? gen.versions[gen.versions.length - 1]
            : null;
        const projectKey = gen.issueKey ? extractProject(gen.issueKey) : null;
        return res.json({
            success: true,
            data: {
                email: gen.email,
                content: gen.result?.markdown?.content || '',
                filename: gen.result?.markdown?.filename || 'output.md',
                format: 'markdown',
                issueKey: gen.issueKey,
                projectKey: projectKey,
                updatedAt: gen.updatedAt,
                published: gen.published || false,
                publishedAt: gen.publishedAt,
                publishedBy: gen.publishedBy,
                currentVersion: gen.currentVersion || 1,
                versions: gen.versions || [],
                lastUpdatedBy: latestVersion?.updatedBy || gen.email,
                lastUpdatedAt: latestVersion?.updatedAt || gen.updatedAt || gen.createdAt,
                images: gen.images || [],
                imagesCount: gen.images ? gen.images.length : 0
            }
        });
    } catch (e) {
        next(e);
    }
});

// Update generation content (only owner can update)
router.put('/:id/content', requireAuth, async (req, res, next) => {
    try {
        const { content } = req.body;
        if (typeof content !== 'string') {
            return res.status(400).json({ success: false, error: 'content must be a string' });
        }

        const gen = await Generation.findById(req.params.id);
        if (!gen || gen.email !== req.user.email) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        if (gen.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Can only update completed generations' });
        }

        // Track version: save current content as a version before updating
        const currentContent = gen.result?.markdown?.content || '';
        if (currentContent && currentContent !== content) {
            // Initialize versions array if needed
            if (!gen.versions) gen.versions = [];

            // Get the current version number (defaults to 1 if not set)
            const currentVersionNum = gen.currentVersion || 1;

            // Save the current content as a version (only if we haven't already saved this version)
            const versionExists = gen.versions.some(v => v.version === currentVersionNum);
            if (!versionExists) {
                gen.versions.push({
                    version: currentVersionNum,
                    content: currentContent,
                    updatedAt: new Date(),
                    updatedBy: req.user.email
                });
                logger.info(`Saved version ${currentVersionNum} to versions array for generation ${req.params.id}`);
            }

            // Increment version for the new content
            gen.currentVersion = currentVersionNum + 1;

            logger.info(`Updating generation ${req.params.id} to version ${gen.currentVersion}`);
        }

        // Update the markdown content
        if (!gen.result) gen.result = {};
        if (!gen.result.markdown) gen.result.markdown = {};
        gen.result.markdown.content = content;

        await gen.save();

        return res.json({
            success: true,
            data: {
                content: gen.result.markdown.content,
                currentVersion: gen.currentVersion || 1
            }
        });
    } catch (e) {
        next(e);
    }
});

// Publish/Unpublish generation
router.put('/:id/publish', requireAuth, async (req, res, next) => {
    try {
        const { published } = req.body;
        if (typeof published !== 'boolean') {
            return res.status(400).json({ success: false, error: 'published must be a boolean' });
        }

        const gen = await Generation.findById(req.params.id);
        if (!gen || gen.email !== req.user.email) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        if (gen.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Can only publish completed generations' });
        }

        gen.published = published;
        if (published) {
            gen.publishedAt = new Date();
            gen.publishedBy = req.user.email;
            logger.info(`Generation ${req.params.id} published by ${req.user.email}`);
        } else {
            gen.publishedAt = undefined;
            gen.publishedBy = undefined;
            logger.info(`Generation ${req.params.id} unpublished by ${req.user.email}`);
        }

        await gen.save();

        return res.json({
            success: true,
            data: {
                published: gen.published,
                publishedAt: gen.publishedAt,
                publishedBy: gen.publishedBy
            }
        });
    } catch (e) {
        next(e);
    }
});

router.get('/:id/download', requireAuth, async (req, res, next) => {
    try {
        const gen = await Generation.findById(req.params.id);
        if (!gen) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        const isOwner = gen.email === req.user.email;
        const isPublishedAndCompleted = gen.published && gen.status === 'completed';

        if (!isOwner && !isPublishedAndCompleted) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        if (gen.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Not completed' });
        }

        const format = typeof req.query.format === 'string'
            ? req.query.format
            : 'md';

        const FORMAT_CONFIG = {
            md: {
                mime: 'text/markdown',
                ext: 'md'
            },
            pdf: {
                mime: 'application/pdf',
                ext: 'pdf'
            },
            xlsx: {
                mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                ext: 'xlsx'
            }
        };

        const config = FORMAT_CONFIG[format];
        if (!config) {
            return res.status(400).json({ success: false, error: 'Unsupported format' });
        }

        let buffer;
        let filename = `output.${config.ext}`;

        if (format === 'md') {
            buffer = Buffer.from(gen.result?.markdown?.content || '', 'utf-8');
            filename = gen.result?.markdown?.filename || filename;
        }

        if (format === 'xlsx') {
            buffer = await generateExcelBuffer(gen);
        }

        if (format === 'pdf') {
            buffer = gen.result?.pdf?.buffer; // hoặc generatePdfBuffer(gen)
        }

        if (!buffer) {
            return res.status(404).json({
                success: false,
                error: `File "${format}" not generated`
            });
        }

        res.setHeader('Content-Type', config.mime);
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filename}"`
        );

        return res.send(buffer);
    } catch (e) {
        console.error('DOWNLOAD ERROR:', e);
        next(e);
    }
});

// Delete generation (only owner can delete)
router.delete('/:id', requireAuth, async (req, res, next) => {
    try {
        const gen = await Generation.findById(req.params.id);
        if (!gen) {
            return res.status(404).json({ success: false, error: 'Generation not found' });
        }

        // Only the owner can delete their generation
        if (gen.email !== req.user.email) {
            return res.status(403).json({ success: false, error: 'You can only delete your own generations' });
        }

        // Check if it's published - warn but allow deletion
        if (gen.published) {
            logger.warn(`User ${req.user.email} is deleting published generation ${req.params.id}`);
        }

        // Delete the generation
        await Generation.findByIdAndDelete(req.params.id);

        logger.info(`Generation ${req.params.id} deleted by ${req.user.email}`);
        return res.json({ success: true, message: 'Generation deleted successfully' });
    } catch (e) {
        next(e);
    }
});

// Get all generations (user's own + published ones) with pagination
router.get('/', requireAuth, async (req, res, next) => {
    try {
        // Parse pagination parameters
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
        const skip = (page - 1) * limit;

        const filterType = req.query.filter || 'all';


        // Filter: user's own OR published and completed
        let filter = {};

        if (filterType === 'mine') {
            // Only user's own generations
            filter = { email: req.user.email };
        } else if (filterType === 'published') {
            // Only published generations
            filter = { published: true, status: 'completed' };
        } else {
            // Default: user's own OR published ones from all users
            filter = {
                $or: [
                    { email: req.user.email },
                    { published: true, status: 'completed' }
                ]
            };
        }

        // Fetch generations with pagination
        const [generations, total] = await Promise.all([
            Generation.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
            Generation.countDocuments(filter)
        ]);

        // Calculate total pages
        const pages = Math.ceil(total / limit);

        return res.json({
            success: true,
            data: {
                generations,
                pagination: {
                    page,
                    limit,
                    total,
                    pages
                }
            }
        });
    } catch (e) {
        next(e);
    }
});

// Serve uploaded images
router.get('/images/:filename', requireAuth, async (req, res, next) => {
    try {
        const { filename } = req.params;
        
        // Security: validate filename to prevent directory traversal
        if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ success: false, error: 'Invalid filename' });
        }

        const imagePath = path.join(path.dirname(path.dirname(__dirname)), 'uploads', filename);
        
        // Check if file exists
        if (!fs.existsSync(imagePath)) {
            return res.status(404).json({ success: false, error: 'Image not found' });
        }

        // Set appropriate headers
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
        
        // Stream the file
        const fileStream = fs.createReadStream(imagePath);
        fileStream.pipe(res);
    } catch (error) {
        logger.error('Image serving error:', error);
        next(error);
    }
});

// Cleanup old images periodically (can be called manually or via cron)
router.post('/cleanup-images', requireAuth, async (req, res, next) => {
    try {
        // Only allow admin users or add proper authorization
        const maxAgeHours = parseInt(req.body.maxAgeHours) || 24;
        cleanupOldImages(maxAgeHours);
        
        return res.json({
            success: true,
            message: `Cleaned up images older than ${maxAgeHours} hours`
        });
    } catch (error) {
        logger.error('Cleanup error:', error);
        next(error);
    }
});

export default router;

