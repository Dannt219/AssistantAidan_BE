import { Router } from "express";
import JiraService from '../services/jiraService.js'
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";

const router = Router();
let jiraService = null;
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

router.post('/preflight', requireAuth, async (req, res, next) => {
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

export default router;

