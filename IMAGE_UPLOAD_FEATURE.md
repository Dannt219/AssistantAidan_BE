# Image Upload Feature

## Overview
This feature allows users to upload images (UI mockups, wireframes, screenshots) to enhance test case generation with visual context using OpenAI's Vision API.

## Architecture
The feature uses a **session-based approach** that separates image upload from test case generation:

1. **Upload Phase**: Images are uploaded and stored in a temporary session
2. **Generation Phase**: Test cases are generated using images from the session
3. **Cleanup Phase**: Session and images are automatically cleaned up

This approach provides better user experience and clearer separation of concerns.

## Features

### Backend
- **File Upload**: Support for multiple image formats (JPEG, PNG, GIF, WebP)
- **Image Processing**: Automatic compression and resizing using Sharp
- **Vision AI**: Integration with GPT-4o Vision model for image analysis
- **Storage**: Local file storage with cleanup mechanisms
- **Security**: File type validation, size limits, and path sanitization

### Frontend
- **Drag & Drop**: Intuitive image upload interface
- **Preview**: Image thumbnails with metadata
- **Validation**: Client-side file type and size validation
- **Gallery**: View uploaded images in generation results

## API Endpoints

### Upload Images
```
POST /generations/upload-images
Content-Type: multipart/form-data
```
- Upload up to 5 images (10MB each)
- Creates a temporary session (30 minutes)
- Returns session ID and processed image information

### Get Image Session
```
GET /generations/image-sessions/:sessionId
```
- Get information about an image session
- Returns session details and image list

### List User Sessions
```
GET /generations/image-sessions
```
- List all active image sessions for the user
- Returns session summaries

### Delete Image Session
```
DELETE /generations/image-sessions/:sessionId
```
- Manually delete an image session
- Cleans up associated files

### Generate with Images
```
POST /generations/testcases
Content-Type: application/json
Body: { "issueKey": "PROJ-123", "imageSessionId": "session_id" }
```
- Reference images using session ID
- Uses GPT-4o Vision model when images are present
- Automatically cleans up session after generation

### Serve Images
```
GET /generations/images/:filename
```
- Serves uploaded images with proper caching headers
- Requires authentication

## Configuration

### Environment Variables
```env
OPENAI_VISION_MODEL=gpt-4o  # Vision model for image analysis
```

### File Limits
- Maximum files: 5 per request
- Maximum size: 10MB per file
- Supported formats: JPEG, PNG, GIF, WebP
- Output format: JPEG (compressed to 85% quality)
- Maximum dimensions: 1920x1080 (auto-resize)

## Database Schema

### Generation Model Updates
```javascript
images: [{
  originalName: String,    // Original filename
  filename: String,        // Processed filename
  filepath: String,        // Full file path
  mimetype: String,        // MIME type
  size: Number,           // Processed file size
  originalSize: Number,    // Original file size
  width: Number,          // Image width
  height: Number,         // Image height
  uploadedAt: Date        // Upload timestamp
}]
```

## Cost Implications

### Model Pricing
- **GPT-4o Vision**: $2.50/1M input tokens, $10.00/1M output tokens
- **GPT-4o Mini**: $0.15/1M input tokens, $0.60/1M output tokens
- **Image tokens**: ~1000 tokens per image (estimated)

### Cost Estimation
The system automatically calculates estimated costs based on:
- Text content tokens
- Number of images × 1000 tokens each
- Model pricing (Vision vs Mini)

## File Management

### Storage Location
```
ntdsdet_test_assistant_be/uploads/
```

### Cleanup
- **Automatic**: Old images cleaned up after 24 hours
- **Manual**: Run cleanup script
```bash
npm run cleanup-images [hours]
```

### Cron Job (Optional)
```bash
# Add to crontab for daily cleanup
0 2 * * * cd /path/to/project && npm run cleanup-images
```

## Security Considerations

1. **File Validation**: Only image files allowed
2. **Size Limits**: 10MB per file, 5 files max
3. **Path Sanitization**: Prevent directory traversal
4. **Authentication**: All endpoints require valid JWT
5. **Cleanup**: Automatic removal of old files

## Usage Examples

### Frontend Usage
```typescript
// Step 1: Upload images
const formData = new FormData();
images.forEach(image => {
    formData.append('images', image);
});

const uploadResponse = await api.post('/generations/upload-images', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
});

const { sessionId } = uploadResponse.data.data;

// Step 2: Generate test cases with images
const generateResponse = await api.post('/generations/testcases', {
    issueKey: 'PROJ-123',
    imageSessionId: sessionId
});
```

### Backend Processing
```javascript
// Get images from session
const session = ImageSessionManager.getSession(imageSessionId, userEmail);
const sessionImages = session ? session.images : [];

// Images are automatically processed and included in OpenAI request
const result = await openai.generateTestCases(
    context, 
    issueKey, 
    autoMode, 
    sessionImages  // Array of processed images from session
);

// Cleanup session after successful generation
ImageSessionManager.cleanupSession(imageSessionId);
```

## Troubleshooting

### Common Issues

1. **Large File Uploads**
   - Ensure files are under 10MB
   - Check server upload limits

2. **Image Processing Errors**
   - Verify Sharp installation
   - Check file format support

3. **Vision API Errors**
   - Verify OpenAI API key
   - Check model availability

4. **Storage Issues**
   - Ensure uploads directory exists
   - Check file permissions

### Error Messages
- `Invalid file type`: Only image files allowed
- `File size must be less than 10MB`: File too large
- `Maximum 5 images allowed`: Too many files
- `Image processing failed`: Sharp processing error

## Performance Considerations

1. **Image Compression**: Automatic JPEG compression to 85% quality
2. **Resize**: Large images resized to max 1920x1080
3. **Caching**: Images served with cache headers
4. **Cleanup**: Regular cleanup prevents disk space issues

## Future Enhancements

1. **Cloud Storage**: AWS S3 or similar for production
2. **Image Analysis**: More detailed visual analysis
3. **Batch Processing**: Async image processing
4. **CDN Integration**: Faster image delivery
5. **Advanced Validation**: Content-based image validation