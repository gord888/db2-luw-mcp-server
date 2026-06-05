import { access, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import yaml from 'yaml';
import { z } from 'zod/v4';

import type { ResolvedConfig } from '../config/types.js';
import { AppError } from '../errors/AppError.js';
import type { DescriptorCatalog } from '../descriptors/descriptorCatalog.js';
import type { DescriptorCatalogDocument } from '../descriptors/descriptorTypes.js';

const descriptorDocumentSchema = z.object({
  tables: z.array(z.object({
    schema: z.string().min(1),
    table: z.string().min(1),
    businessName: z.string().optional(),
    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    owner: z.string().optional(),
    sensitivity: z.string().optional(),
    importantColumns: z.array(z.object({
      name: z.string().min(1),
      description: z.string().min(1)
    })).optional(),
    relationships: z.array(z.object({
      target: z.string().min(1),
      type: z.string().min(1),
      join: z.string().min(1),
      description: z.string().optional()
    })).optional(),
    exampleQuestions: z.array(z.string()).optional(),
    exampleQueries: z.array(z.object({
      name: z.string().min(1),
      sql: z.string().min(1)
    })).optional()
  })).optional()
});

export interface DescriptorFileInfo {
  path: string;
  name: string;
  lastModified: string;
  size: number;
  valid: boolean;
  tableCount: number;
  error?: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function validateDescriptorYaml(content: string): { valid: boolean; tableCount: number; error?: string } {
  try {
    const parsed = yaml.parse(content) as DescriptorCatalogDocument;
    const result = descriptorDocumentSchema.safeParse(parsed);
    if (!result.success) {
      return { valid: false, tableCount: 0, error: result.error.message };
    }
    const tables = result.data.tables ?? [];
    return { valid: true, tableCount: tables.length };
  } catch (err) {
    return { valid: false, tableCount: 0, error: `YAML parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function listDescriptorFiles(paths: string[], descriptorDir?: string): Promise<DescriptorFileInfo[]> {
  const results: DescriptorFileInfo[] = [];
  const seenPaths = new Set<string>();

  for (const filePath of paths) {
    try {
      const stats = await stat(filePath);
      seenPaths.add(filePath);
      let content = '';
      try {
        content = await readFile(filePath, 'utf8');
      } catch { /* unreadable — treat as invalid */ }
      const validation = content ? validateDescriptorYaml(content) : { valid: false, tableCount: 0, error: 'File is empty or unreadable' };
      results.push({
        path: filePath,
        name: basename(filePath),
        lastModified: stats.mtime.toISOString(),
        size: stats.size,
        valid: validation.valid,
        tableCount: validation.tableCount,
        error: validation.error
      });
    } catch { /* file doesn't exist — skip */ }
  }

  // Also scan the descriptor directory for additional YAML files (e.g. uploaded via UI)
  if (descriptorDir) {
    try {
      const entries = await readdir(descriptorDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
        const fullPath = `${descriptorDir}/${entry.name}`;
        if (seenPaths.has(fullPath)) continue; // already listed from config

        try {
          const stats = await stat(fullPath);
          seenPaths.add(fullPath);
          let content = '';
          try {
            content = await readFile(fullPath, 'utf8');
          } catch { /* skip unreadable */ }
          const validation = content ? validateDescriptorYaml(content) : { valid: false, tableCount: 0, error: 'File is empty or unreadable' };
          results.push({
            path: fullPath,
            name: entry.name,
            lastModified: stats.mtime.toISOString(),
            size: stats.size,
            valid: validation.valid,
            tableCount: validation.tableCount,
            error: validation.error
          });
        } catch { /* skip inaccessible files */ }
      }
    } catch { /* directory not readable — skip */ }
  }

  return results;
}

async function getDescriptorContent(filePath: string): Promise<string> {
  if (!(await fileExists(filePath))) {
    throw new AppError('VALIDATION_ERROR', `Descriptor file not found: ${filePath}`, 404);
  }
  return readFile(filePath, 'utf8');
}

async function getDescriptorDir(config: ResolvedConfig): Promise<string> {
  const uploadDirEnv = process.env.DB2_MCP_DESCRIPTOR_UPLOAD_DIR;
  if (uploadDirEnv) {
    return uploadDirEnv;
  }
  if (config.descriptorFiles.length > 0 && config.descriptorFiles[0]) {
    return dirname(config.descriptorFiles[0]);
  }
  // Fallback: use the directory of the config if present, otherwise /app/config for container deployments
  const configPath = process.env.DB2_MCP_CONFIG_PATH;
  if (configPath) {
    return dirname(configPath);
  }
  return process.env.DB2_MCP_CONFIG_DIR ?? '/app/config';
}

export async function handleDescriptorsGet(
  req: IncomingMessage,
  res: ServerResponse,
  config: ResolvedConfig
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const filePath = url.searchParams.get('path');

  if (filePath) {
    try {
      const content = await getDescriptorContent(filePath);
      writeJson(res, 200, { path: filePath, content });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('DB_EXECUTION_FAILED', 'Failed to read descriptor file.', 500);
      writeJson(res, appError.statusCode, { error: appError.message });
    }
    return;
  }

  const files = await listDescriptorFiles(config.descriptorFiles, dirname(config.descriptorFiles[0] ?? '.'));
  writeJson(res, 200, { files });
}

export async function handleDescriptorsPost(
  req: IncomingMessage,
  res: ServerResponse,
  config: ResolvedConfig,
  catalog: DescriptorCatalog,
  body: { filename?: string; content?: string }
): Promise<void> {
  if (!body.content) {
    writeJson(res, 400, { error: 'Missing content field.' });
    return;
  }

  const validation = validateDescriptorYaml(body.content);
  if (!validation.valid) {
    writeJson(res, 400, { error: validation.error, valid: false });
    return;
  }

  const filename = body.filename ?? `descriptors-${Date.now()}.yaml`;
  const dir = await getDescriptorDir(config);
  const filePath = `${dir}/${filename}`;

  try {
    await writeFile(filePath, body.content, 'utf8');
    // Hot-reload: merge the new file into the running catalog
    try {
      await catalog.mergeFromFiles([filePath]);
    } catch {
      // File is saved but catalog reload failed — non-fatal, will be picked up on restart
    }
    writeJson(res, 201, { path: filePath, filename, valid: true, tableCount: validation.tableCount });
  } catch (error) {
    writeJson(res, 500, { error: `Failed to write file: ${error instanceof Error ? error.message : String(error)}` });
  }
}

export async function handleDescriptorsPut(
  req: IncomingMessage,
  res: ServerResponse,
  config: ResolvedConfig,
  catalog: DescriptorCatalog,
  body: { path?: string; content?: string }
): Promise<void> {
  if (!body.path || !body.content) {
    writeJson(res, 400, { error: 'Missing path or content field.' });
    return;
  }

  if (!(await fileExists(body.path))) {
    writeJson(res, 404, { error: `Descriptor file not found: ${body.path}` });
    return;
  }

  const validation = validateDescriptorYaml(body.content);
  if (!validation.valid) {
    writeJson(res, 400, { error: validation.error, valid: false });
    return;
  }

  try {
    await writeFile(body.path, body.content, 'utf8');
    // Hot-reload: merge the updated file into the running catalog
    try {
      await catalog.mergeFromFiles([body.path]);
    } catch {
      // File is saved but catalog reload failed — non-fatal, will be picked up on restart
    }
    writeJson(res, 200, { path: body.path, valid: true, tableCount: validation.tableCount });
  } catch (error) {
    writeJson(res, 500, { error: `Failed to update file: ${error instanceof Error ? error.message : String(error)}` });
  }
}

export async function handleDescriptorsDelete(
  req: IncomingMessage,
  res: ServerResponse,
  config: ResolvedConfig,
  catalog: DescriptorCatalog
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const filePath = url.searchParams.get('path');

  if (!filePath) {
    writeJson(res, 400, { error: 'Missing path parameter.' });
    return;
  }

  if (!(await fileExists(filePath))) {
    writeJson(res, 404, { error: `Descriptor file not found: ${filePath}` });
    return;
  }

  try {
    await unlink(filePath);
    // Reload all configured files to remove deleted tables from the catalog
    try {
      await catalog.mergeFromFiles(config.descriptorFiles);
    } catch {
      // Catalog reload failed — non-fatal
    }
    writeJson(res, 200, { path: filePath, deleted: true });
  } catch (error) {
    writeJson(res, 500, { error: `Failed to delete file: ${error instanceof Error ? error.message : String(error)}` });
  }
}

export function renderDescriptorPage(files: DescriptorFileInfo[], publicBaseUrl?: string, apiKey?: string): string {
  const filesHtml = files.length > 0
    ? files.map((f) => {
        const statusBadge = f.valid
          ? '<span class="badge badge-ok">✅ Valid</span>'
          : '<span class="badge badge-error">❌ Invalid</span>';
        const errorDetail = f.error ? `<div class="error-detail">${escapeHtml(f.error)}</div>` : '';
        const tableInfo = f.valid ? `<span class="meta-item">${f.tableCount} table(s)</span>` : '';
        return `<tr>
          <td><code>${escapeHtml(f.name)}</code></td>
          <td><code class="file-path">${escapeHtml(f.path)}</code></td>
          <td>${statusBadge}${errorDetail}</td>
          <td>${tableInfo}</td>
          <td>${escapeHtml(formatDate(f.lastModified))}</td>
          <td class="actions">
            <button class="btn btn-small btn-view" onclick="viewFile('${escapeHtml(f.path)}')">View / Edit</button>
            <button class="btn btn-small btn-delete" onclick="deleteFile('${escapeHtml(f.path)}')">Delete</button>
          </td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="6" class="empty-row"><em>No descriptor files configured.</em></td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>DB2 LUW MCP — Descriptor Manager</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f0f2f5; color: #1a1a2e; line-height: 1.6; }
    .container { max-width: 1100px; margin: 0 auto; padding: 1.5rem; }
    header { background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%); color: #fff; border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.12); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem; }
    header h1 { font-size: 1.4rem; color: #fff; }
    nav a { color: rgba(255,255,255,0.85); text-decoration: none; font-size: 0.9rem; font-weight: 500; margin-left: 1rem; }
    nav a:hover { color: #fff; text-decoration: underline; }
    .card { background: #fff; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size: 1.15rem; color: #333; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid #e5e7eb; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th { text-align: left; background: #f8fafc; color: #475569; font-weight: 600; padding: 0.6rem 0.75rem; border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
    td { padding: 0.6rem 0.75rem; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    tr:hover td { background: #f8fafc; }
    code { background: #eef2ff; color: #4338ca; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.85em; font-family: 'SF Mono', 'Fira Code', monospace; }
    .file-path { font-size: 0.8em; color: #64748b; display: block; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
    .badge-ok { background: #dcfce7; color: #166534; }
    .badge-error { background: #fef2f2; color: #991b1b; }
    .meta-item { font-size: 0.8rem; color: #64748b; }
    .error-detail { font-size: 0.75rem; color: #991b1b; margin-top: 0.25rem; max-width: 250px; word-break: break-all; }
    .actions { white-space: nowrap; }
    .btn { padding: 0.4rem 0.85rem; border: none; border-radius: 5px; font-size: 0.85rem; cursor: pointer; font-weight: 500; transition: background 0.15s; }
    .btn-small { font-size: 0.78rem; padding: 0.3rem 0.6rem; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-view { background: #e0e7ff; color: #3730a3; }
    .btn-view:hover { background: #c7d2fe; }
    .btn-delete { background: #fee2e2; color: #991b1b; }
    .btn-delete:hover { background: #fecaca; }
    .btn-cancel { background: #f1f5f9; color: #475569; margin-left: 0.5rem; }
    .btn-cancel:hover { background: #e2e8f0; }
    .empty-row { text-align: center; color: #94a3b8; padding: 2rem; }
    textarea { width: 100%; font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 0.85rem; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; resize: vertical; background: #fafbfc; }
    textarea:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
    .form-row { margin-bottom: 1rem; }
    .form-row label { display: block; font-weight: 600; margin-bottom: 0.3rem; color: #374151; font-size: 0.9rem; }
    .form-row input[type="text"] { width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 5px; font-size: 0.9rem; }
    .form-row input[type="text"]:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
    #editor-section { display: none; }
    #validation-result { margin-top: 0.5rem; font-size: 0.85rem; padding: 0.5rem; border-radius: 4px; }
    .validation-ok { background: #dcfce7; color: #166534; }
    .validation-error { background: #fef2f2; color: #991b1b; }
    .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: 0.75rem 1.25rem; border-radius: 6px; color: #fff; font-weight: 500; font-size: 0.9rem; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 1000; animation: slideIn 0.3s ease; }
    .toast-success { background: #16a34a; }
    .toast-error { background: #dc2626; }
    @keyframes slideIn { from { transform: translateY(1rem); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📋 Descriptor File Manager</h1>
      <nav>
        <a href="/status">Status Page</a>
        <a href="/descriptors">Descriptors</a>
        <a href="/healthz">Health</a>
      </nav>
    </header>

    <div class="card">
      <h2>Upload New Descriptor</h2>
      <div class="form-row">
        <label for="upload-filename">Filename</label>
        <input type="text" id="upload-filename" placeholder="e.g. my-tables.yaml" />
      </div>
      <div class="form-row">
        <label for="upload-content">YAML Content</label>
        <textarea id="upload-content" rows="10" placeholder="tables:
  - schema: &quot;MYSCHEMA&quot;
    table: &quot;MYTABLE&quot;
    businessName: &quot;...&quot;"></textarea>
      </div>
      <div id="upload-validation" style="margin-bottom:0.75rem;"></div>
      <button class="btn btn-primary" onclick="uploadFile()">Upload</button>
      <button class="btn btn-cancel" onclick="clearUpload()">Clear</button>
    </div>

    <div class="card" id="editor-section">
      <h2>Editing: <code id="editor-filename">—</code></h2>
      <textarea id="editor-content" rows="20"></textarea>
      <div id="validation-result"></div>
      <div style="margin-top:0.75rem;">
        <button class="btn btn-primary" onclick="saveEdit()">Save Changes</button>
        <button class="btn btn-cancel" onclick="closeEditor()">Cancel</button>
      </div>
    </div>

    <div class="card">
      <h2>Current Descriptor Files</h2>
      <table>
        <thead>
          <tr><th>File</th><th>Path</th><th>Status</th><th>Tables</th><th>Last Modified</th><th>Actions</th></tr>
        </thead>
        <tbody>${filesHtml}</tbody>
      </table>
    </div>
  </div>

  <div id="toast-container"></div>

  <script>
    const API_KEY = ${apiKey ? JSON.stringify(apiKey) : 'null'};
    let editingPath = null;

    function showToast(message, type) {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast ' + (type === 'error' ? 'toast-error' : 'toast-success');
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 4000);
    }

    document.getElementById('upload-content').addEventListener('input', function() {
      const el = document.getElementById('upload-validation');
      if (this.value.trim()) {
        el.innerHTML = '<div class="validation-ok">✅ YAML content present (server validates on upload).</div>';
      } else {
        el.innerHTML = '';
      }
    });

    async function uploadFile() {
      const filename = document.getElementById('upload-filename').value.trim();
      const content = document.getElementById('upload-content').value.trim();
      if (!content) { showToast('Please enter YAML content.', 'error'); return; }
      const body = { content };
      if (filename) body.filename = filename;
      try {
        const res = await fetch('/api/descriptors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (res.ok) {
          showToast('File uploaded: ' + (data.filename || data.path), 'success');
          clearUpload();
          location.reload();
        } else {
          showToast('Upload failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (e) {
        showToast('Network error: ' + e.message, 'error');
      }
    }

    function clearUpload() {
      document.getElementById('upload-filename').value = '';
      document.getElementById('upload-content').value = '';
      document.getElementById('upload-validation').innerHTML = '';
    }

    async function viewFile(path) {
      try {
        const res = await fetch('/api/descriptors?path=' + encodeURIComponent(path), {
          headers: { 'Authorization': 'Bearer ' + API_KEY }
        });
        const data = await res.json();
        if (res.ok) {
          editingPath = path;
          document.getElementById('editor-filename').textContent = path;
          document.getElementById('editor-content').value = data.content;
          document.getElementById('editor-section').style.display = 'block';
          document.getElementById('validation-result').innerHTML = '';
          document.getElementById('editor-section').scrollIntoView({ behavior: 'smooth' });
        } else {
          showToast('Failed to load: ' + (data.error || 'Unknown'), 'error');
        }
      } catch (e) {
        showToast('Network error: ' + e.message, 'error');
      }
    }

    async function saveEdit() {
      if (!editingPath) return;
      const content = document.getElementById('editor-content').value;
      try {
        const res = await fetch('/api/descriptors', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
          body: JSON.stringify({ path: editingPath, content })
        });
        const data = await res.json();
        if (res.ok) {
          showToast('Saved (' + data.tableCount + ' tables).', 'success');
          closeEditor();
          location.reload();
        } else {
          document.getElementById('validation-result').innerHTML =
            '<div class="validation-error">❌ ' + (data.error || 'Unknown') + '</div>';
          showToast('Validation failed.', 'error');
        }
      } catch (e) {
        showToast('Network error: ' + e.message, 'error');
      }
    }

    function closeEditor() {
      editingPath = null;
      document.getElementById('editor-section').style.display = 'none';
      document.getElementById('editor-content').value = '';
      document.getElementById('validation-result').innerHTML = '';
    }

    async function deleteFile(path) {
      if (!confirm('Delete ' + path + '? This cannot be undone.')) return;
      try {
        const res = await fetch('/api/descriptors?path=' + encodeURIComponent(path), {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + API_KEY }
        });
        const data = await res.json();
        if (res.ok) {
          showToast('File deleted.', 'success');
          location.reload();
        } else {
          showToast('Delete failed: ' + (data.error || 'Unknown'), 'error');
        }
      } catch (e) {
        showToast('Network error: ' + e.message, 'error');
      }
    }
  </script>
</body>
</html>`;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}
