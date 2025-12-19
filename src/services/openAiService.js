import dotenv from 'dotenv';
dotenv.config();
import OpenAI from 'openai';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

const MANUAL_PROMPT = `You are an expert manual QA Engineer. Generate comprehensive test cases from JIRA issue descriptions.

**Context:** You will receive JIRA issue details including title, description, comments, and acceptance criteria. Use ONLY this information - never invent requirements.

**Image Analysis:** If images are provided, analyze them carefully to understand:
- UI layouts, wireframes, mockups, or screenshots
- User interface elements (buttons, forms, navigation)
- Visual design requirements and specifications
- User workflows and interaction patterns
- Error states or validation messages shown

**Output Requirements:**
1. Use proper markdown with ## for main headings and - for bullet points
2. Include a title: "# Test Cases for [JIRA-ID]: [Issue Title]"
3. Structure by categories: ## **Functional Requirements**, ## **UI & Visual Validation**, ## **Edge Cases**, ## **Data Integrity** (if applicable)
4. Include blank lines before and after lists
5. Each test case should be:
   - Clear and actionable
   - Cover specific acceptance criteria
   - Include preconditions, steps, and expected results
   - Prioritized (High/Medium/Low)
   - Reference visual elements from images when applicable

**Must NOT:**
- Never mention specific individual names
- Never include implementation details (HTML classes, functions)
- Never invent requirements not in the JIRA issue or images

**Coverage:**
- Positive and negative test cases
- Edge cases and boundary conditions
- Error handling
- User workflows
- Form validations
- State transitions
- Accessibility considerations (if UI-related)
- Visual validation based on provided images

Generate comprehensive test cases now.`;

const AUTO_PROMPT = `You are an expert QA automation specialist. Generate automation-friendly test cases from JIRA issue descriptions.

**Context:** You will receive JIRA issue details. Use ONLY this information - never invent requirements.

**Image Analysis:** If images are provided, analyze them to identify:
- Specific UI elements that can be automated (buttons, inputs, selectors)
- Element hierarchies and relationships
- Data validation requirements shown in mockups
- User interaction flows and navigation paths
- Expected states and transitions

**Output Requirements:**
1. Use proper markdown format
2. Title: "# Automation Tests for [JIRA-ID]: [Issue Title]"
3. Structure tests by acceptance criteria
4. Include blank lines before and after lists
5. Each test should specify:
   - Clear, automatable steps
   - Specific UI elements or data to verify (based on images when available)
   - Assertion points
   - Test data requirements
   - Element identification strategies

**Must NOT:**
- Never include subjective validations
- Never write vague steps
- Never include non-verifiable assertions

**Focus on:**
- Idempotent, independent test scenarios
- Clear element identification strategies based on visual analysis
- Repeatable test data
- Programmatically verifiable assertions
- Error handling in automation
- State management
- Visual regression testing when images show UI states

Generate automation-friendly test cases now.`;

export default class OpenAIService {
    constructor() {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY is not set in envinronment variable')
        }
        this.client = new OpenAI({ apiKey });
        this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
        this.visionModel = process.env.OPENAI_VISION_MODEL || 'gpt-4o'
        this.maxCompletionTokens = 8000;
        this.maxRetries = 3;
    }

    // Helper method to convert image to base64
    imageToBase64(imagePath) {
        try {
            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');
            const ext = path.extname(imagePath).toLowerCase();
            const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
            return `data:${mimeType};base64,${base64Image}`;
        } catch (error) {
            logger.error(`Failed to convert image to base64: ${error.message}`);
            throw error;
        }
    }
    async generateTestCases(context, issueKey, autoMode = false, images = []) {
        try {
            const systemPrompt = autoMode ? AUTO_PROMPT : MANUAL_PROMPT;
            const hasImages = images && images.length > 0;
            const modelToUse = hasImages ? this.visionModel : this.model;

            // Build user message content
            let issueContext = `\n\nJIRA issue: ${issueKey} \n\n${context}`;
            
            if (hasImages) {
                issueContext += `\n\nImages provided: ${images.length} image(s) for analysis.`;
            }

            const message = [
                {
                    role: 'system',
                    content: systemPrompt
                }
            ];

            let userMessage = {
                role: 'user',
                content: []
            };

            // Add text content
            userMessage.content.push({
                type: 'text',
                text: issueContext
            });

            // Add images if provided
            if (hasImages) {
                for (const image of images) {
                    try {
                        const base64Image = this.imageToBase64(image.filepath);
                        userMessage.content.push({
                            type: 'image_url',
                            image_url: {
                                url: base64Image,
                                detail: 'high' // Use high detail for better analysis
                            }
                        });
                        logger.info(`Added image to OpenAI request: ${image.originalName}`);
                    } catch (error) {
                        logger.warn(`Failed to process image ${image.originalName}: ${error.message}`);
                    }
                }
            }

            // If no images, use simple text content
            if (!hasImages) {
                userMessage.content = issueContext;
            }

            message.push(userMessage);

            // Retry logic
            let retryCount = 0;
            let lastError;

            while (retryCount < this.maxRetries) {
                try {
                    logger.info(`Calling OpenAI (attempt ${retryCount + 1}/${this.maxRetries}) with model: ${modelToUse}${hasImages ? ` and ${images.length} image(s)` : ''}`);

                    const response = await this.client.chat.completions.create({
                        model: modelToUse,
                        messages: message,
                        max_completion_tokens: this.maxCompletionTokens,
                        temperature: 0.7
                    });

                    const content = response.choices[0]?.message?.content;
                    if (!content) {
                        throw new Error(`Empty response frpm OpenAi`);
                    }
                    logger.info(`OpenAi generation successfully (${response.usage?.total_tokens || 0})`);

                    // get real token used info
                    const usage = response.usage || {};
                    const tokenUsage = {
                        promptTokens: usage.promptToken || 0,
                        completionTokens: usage.completion_tokens || 0,
                        totalTokens: usage.total_tokens || 0
                    }

                    // Calculate cost based on model pricing
                    let inputCost, outputCost;
                    
                    if (modelToUse === this.visionModel) {
                        // gpt-4o pricing: $2.50/1M input tokens, $10.00/1M output tokens
                        inputCost = (tokenUsage.promptTokens / 1000000) * 2.50;
                        outputCost = (tokenUsage.completionTokens / 1000000) * 10.00;
                    } else {
                        // gpt-4o-mini pricing: $0.15/1M input tokens, $0.60/1M output tokens
                        inputCost = (tokenUsage.promptTokens / 1000000) * 0.15;
                        outputCost = (tokenUsage.completionTokens / 1000000) * 0.60;
                    }
                    
                    const totalCost = inputCost + outputCost;

                    return {
                        content,
                        tokenUsage,
                        cost: totalCost
                    }

                } catch (error) {
                    lastError = error;
                    retryCount++;

                    if (retryCount <= this.maxRetries) {
                        const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff
                        logger.warn(`OpenAI API error (attempt ${retryCount}): ${error.message}. Retrying in ${waitTime}ms...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else {
                        logger.error(`OpenAI API failed after ${this.maxRetries + 1} attempts: ${error.message}`);
                        throw error;
                    }
                }
            }

        } catch (error) {
            logger.error(`Failed to generate test case: ${error.message}`)
            throw error;
        }
    }
}