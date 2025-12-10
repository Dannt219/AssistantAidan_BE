import { Router } from "express";
import JiraService from '../services/jiraService.js'
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";
import OpenAIService from "../services/openAiService.js";
import Generation from '../models/Generation.js'
import { extractProject, findOrCreateProject } from '../utils/projectUtils.js'

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
    const estimatedTokens = Math.ceil(contextLength / 4) + (imageAttachments.length * 200); // ~200 tokens per image

    // Estimate cost (gpt-4o-mini pricing: $0.15/1M input tokens, $0.60/1M output tokens)
    const estimatedCost = (estimatedTokens / 1000000) * 0.15 + (8000 / 1000000) * 0.60; // Assume ~8k output tokens

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

router.post('/testcases', requireAuth, async (req, res, next) => {
    try {
        const { issueKey, async: isAsync = false, autoMode = false } = req.body || {};
        if (!issueKey) {
            return res.status(400).json({ success: false, error: 'issueKey required' });
        }

        // Extract project key and find/create project
        const projectKey = extractProjectKey(issueKey);
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
            startedAt: isAsync ? undefined : new Date()
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
            const openai = getOpenAIService();
            const openaiImages = [];

            logger.info(`Generating test cases with OpenAI (mode: ${autoMode ? 'auto' : 'manual'})`);
            const result = await openai.generateTestCases(context, issueKey, autoMode, openaiImages);

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
        return res.json({
            success: true,
            data: {
                generationId: String(generation._id),
                issueKey,
                markdown: generation.result.markdown,
                generationTimeSeconds: generation.generationTimeSeconds,
                cost: generation.cost
            }
        });
    } catch (e) {
        next(e);
    }
});

export default router;

