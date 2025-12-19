import ExcelJS from 'exceljs';

function cleanMarkdown(text = '') {
    return text
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/^\s*[-*•]\s+/gm, '')
        .replace(/[`>]/g, '')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

function extractSection(text, heading) {
    const pattern = new RegExp(
        `##\\s*${heading}[\\s\\S]*?(?=\\n##\\s|$)`,
        'i'
    );
    const match = text.match(pattern);
    if (!match) return '';

    return match[0]
        .replace(new RegExp(`##\\s*${heading}`, 'i'), '')
        .trim();
}

function parseTestCases(markdown) {
    const cases = [];
    const blocks = markdown.split(/Test Case \d+/).slice(1);

    blocks.forEach((block, index) => {
        const rawTitle = block.split('\n')[0].trim();

        cases.push({
            id: `Test Case ${index + 1}`,
            title: cleanMarkdown(rawTitle),
            priority: cleanMarkdown(extractSection(block, 'Priority')),
            preconditions: cleanMarkdown(extractSection(block, 'Preconditions')),
            steps: cleanMarkdown(extractSection(block, 'Steps')),
            expected: cleanMarkdown(extractSection(block, 'Expected Results')),
        });
    });

    return cases;
}

export async function generateExcelBuffer(gen) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Test Cases');

    sheet.columns = [
        { header: 'Test Case', key: 'id', width: 15 },
        { header: 'Title', key: 'title', width: 40 },
        { header: 'Priority', key: 'priority', width: 12 },
        { header: 'Preconditions', key: 'preconditions', width: 40 },
        { header: 'Steps', key: 'steps', width: 60 },
        { header: 'Expected Results', key: 'expected', width: 60 }
    ];

    sheet.getRow(1).font = { bold: true };

    const markdown = gen.result?.markdown?.content || '';
    const testCases = parseTestCases(markdown);

    testCases.forEach(tc => sheet.addRow(tc));

    sheet.eachRow(row => {
        row.alignment = { wrapText: true, vertical: 'top' };
    });

    return await workbook.xlsx.writeBuffer();
}