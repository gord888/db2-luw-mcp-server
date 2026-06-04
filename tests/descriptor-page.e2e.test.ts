import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const API_KEY = process.env.DB2_MCP_API_KEY ?? 'local-test-key-123';

// Skip in CI — Playwright browser binaries are not installed on CI runners
if (process.env.CI) {
  describe.skip('Descriptor Page E2E (skipped in CI)', () => {});
} else {

/** Pick a free port by binding to an ephemeral port, then releasing it. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine port')));
      }
    });
  });
}

describe('Descriptor Page E2E', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let serverProcess: ReturnType<typeof spawn>;
  let configDir: string;
  let exampleFile: string;
  let BASE: string;

  beforeAll(async () => {
    const port = await getFreePort();
    BASE = `http://localhost:${port}`;

    // Create a temp config dir with the example descriptor
    configDir = join(tmpdir(), `db2-mcp-e2e-${process.pid}`);
    await mkdir(configDir, { recursive: true });
    exampleFile = join(configDir, 'descriptors.example.yaml');
    await writeFile(exampleFile, [
      'tables:',
      '  - schema: "TESTSCHEMA"',
      '    table: "EXAMPLE"',
      '    businessName: "Example Table"',
      '    description: "Used for end-to-end testing."',
      ''
    ].join('\n'));

    // Start the server
    serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB2_MCP_MODE: 'readonly',
        DB2_MCP_API_KEY: API_KEY,
        DB2_MCP_CONNECTION_STRING: 'DATABASE=SAMPLE;HOSTNAME=localhost;PORT=50000;PROTOCOL=TCPIP;UID=test;PWD=test;',
        DB2_MCP_HOST: '127.0.0.1',
        DB2_MCP_PORT: String(port),
        DB2_MCP_PUBLIC_BASE_URL: BASE,
        DB2_MCP_DESCRIPTOR_FILES: exampleFile,
        DB2_MCP_PROCEDURE_ALLOWLIST: 'SYSPROC.GET_DBSIZE_INFO',
      },
      stdio: 'pipe'
    });

    // Wait for the server to start
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timed out')), 15000);
      serverProcess.stdout?.on('data', (data: Buffer) => {
        if (data.toString().includes('listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProcess.stderr?.on('data', (data: Buffer) => {
        // tsx sometimes logs startup messages to stderr — ignore non-fatal output
      });
      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    serverProcess?.kill('SIGTERM');
    // Clean up temp config dir
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  });

  it('loads the descriptor page with file table', { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${BASE}/descriptors`, { waitUntil: 'networkidle' });
      await page.waitForSelector('table tbody tr', { timeout: 5000 });

      const title = await page.title();
      expect(title).toBe('DB2 LUW MCP — Descriptor Manager');

      const fileName = await page.textContent('table tbody tr:first-child td:first-child code');
      expect(fileName).toContain('descriptors.example.yaml');

      const viewBtn = page.locator('table tbody tr:first-child .btn-view');
      expect(await viewBtn.isVisible()).toBe(true);
      const deleteBtn = page.locator('table tbody tr:first-child .btn-delete');
      expect(await deleteBtn.isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('View/Edit button opens editor with file content', { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${BASE}/descriptors`, { waitUntil: 'networkidle' });

      await page.locator('table tbody tr:first-child .btn-view').click();
      await page.waitForSelector('#editor-section:visible', { timeout: 3000 });
      expect(await page.locator('#editor-section').isVisible()).toBe(true);

      const editorContent = await page.locator('#editor-content').inputValue();
      expect(editorContent).toContain('TESTSCHEMA');
      expect(editorContent).toContain('EXAMPLE');

      const editorFilename = await page.textContent('#editor-filename');
      expect(editorFilename).toContain('descriptors.example.yaml');
    } finally {
      await page.close();
    }
  });

  it('Cancel button closes the editor', { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${BASE}/descriptors`, { waitUntil: 'networkidle' });

      await page.locator('table tbody tr:first-child .btn-view').click();
      await page.waitForSelector('#editor-section:visible', { timeout: 3000 });

      // .btn-cancel appears twice: upload card + editor — use the last one
      const cancelBtns = page.locator('.btn-cancel');
      await cancelBtns.last().click();

      await page.waitForSelector('#editor-section', { state: 'hidden', timeout: 3000 }).catch(() => {});
      expect(await page.locator('#editor-section').isHidden()).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('Clear button clears upload form', { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${BASE}/descriptors`, { waitUntil: 'networkidle' });

      await page.fill('#upload-filename', 'test.yaml');
      await page.fill('#upload-content', 'tables:\n  - schema: TEST\n    table: FOO\n');

      await page.locator('button:has-text("Clear")').click();

      expect(await page.inputValue('#upload-filename')).toBe('');
      expect(await page.inputValue('#upload-content')).toBe('');
    } finally {
      await page.close();
    }
  });

  it('uploads a new descriptor file', { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${BASE}/descriptors`, { waitUntil: 'networkidle' });

      await page.fill('#upload-filename', 'e2e-test.yaml');
      await page.fill('#upload-content', 'tables:\n  - schema: E2E\n    table: TEST_TABLE\n    businessName: "E2E Test"\n');

      const uploadBtn = page.locator('button:has-text("Upload")');
      await Promise.all([
        page.waitForResponse(resp =>
          resp.url().includes('/api/descriptors') &&
          resp.request().method() === 'POST' &&
          resp.status() === 201
        , { timeout: 10000 }),
        uploadBtn.click()
      ]);

      // Verify file was saved via API
      const resp = await page.request.get(
        `${BASE}/api/descriptors?path=${encodeURIComponent(join(configDir, 'e2e-test.yaml'))}`,
        { headers: { 'Authorization': `Bearer ${API_KEY}` } }
      );
      expect(resp.status()).toBe(200);
      const data = await resp.json();
      expect(data.content).toContain('E2E Test');
    } finally {
      await page.close();
    }
  });

  it('saves an edit to a descriptor file', { timeout: 10000 }, async () => {
    const page = await browser.newPage();
    try {
      const filePath = join(configDir, 'e2e-test.yaml');

      const putResp = await page.request.put(`${BASE}/api/descriptors`, {
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        data: {
          path: filePath,
          content: 'tables:\n  - schema: E2E\n    table: TEST_TABLE\n    businessName: "E2E Test Modified"\n    description: "Updated via API"\n'
        }
      });
      expect(putResp.status()).toBe(200);
      expect((await putResp.json()).valid).toBe(true);

      const verifyResp = await page.request.get(
        `${BASE}/api/descriptors?path=${encodeURIComponent(filePath)}`,
        { headers: { 'Authorization': `Bearer ${API_KEY}` } }
      );
      const updated = await verifyResp.json();
      expect(updated.content).toContain('E2E Test Modified');
    } finally {
      await page.close();
    }
  });

  it('deletes a descriptor file', { timeout: 10000 }, async () => {
    const page = await browser.newPage();
    try {
      const filePath = join(configDir, 'e2e-test.yaml');

      const delResp = await page.request.delete(
        `${BASE}/api/descriptors?path=${encodeURIComponent(filePath)}`,
        { headers: { 'Authorization': `Bearer ${API_KEY}` } }
      );
      expect(delResp.status()).toBe(200);
      expect((await delResp.json()).deleted).toBe(true);

      const verifyResp = await page.request.get(
        `${BASE}/api/descriptors?path=${encodeURIComponent(filePath)}`,
        { headers: { 'Authorization': `Bearer ${API_KEY}` } }
      );
      expect(verifyResp.status()).toBe(404);
    } finally {
      await page.close();
    }
  });

  it('shows validation error for invalid YAML', { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${BASE}/descriptors`, { waitUntil: 'networkidle' });

      await page.fill('#upload-filename', 'bad.yaml');
      await page.fill('#upload-content', 'this is not valid yaml: [unclosed');

      await page.locator('button:has-text("Upload")').click();
      await page.waitForSelector('.toast-error', { timeout: 5000 });

      const toastText = await page.textContent('.toast-error');
      expect(toastText).toMatch(/failed|error/i);
    } finally {
      await page.close();
    }
  });

  it('navigates to status page from descriptor nav', { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${BASE}/descriptors`, { waitUntil: 'networkidle' });

      await page.click('nav a[href="/status"]');
      await page.waitForURL('**/status', { timeout: 5000 });

      expect(await page.title()).toBe('DB2 LUW MCP Status');
    } finally {
      await page.close();
    }
  });
});
}
