import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadDescriptorCatalog } from '../src/descriptors/descriptorCatalog.js';
import { AppError } from '../src/errors/AppError.js';

describe('loadDescriptorCatalog', () => {
  it('loads descriptors and supports business term search', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'db2-mcp-descriptors-'));
    const descriptorPath = path.join(tempDirectory, 'descriptors.yaml');

    await writeFile(descriptorPath, `
tables:
  - schema: "TMWIN"
    table: "TLORDER"
    businessName: "TruckMate Order"
    aliases:
      - "shipment"
`, 'utf8');

    const catalog = await loadDescriptorCatalog([descriptorPath]);

    expect(catalog.searchBusinessTerms('shipment')).toHaveLength(1);
  });

  it('fails on invalid descriptor files', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'db2-mcp-descriptors-invalid-'));
    const descriptorPath = path.join(tempDirectory, 'descriptors.yaml');

    await writeFile(descriptorPath, `
tables:
  - schema: 123
`, 'utf8');

    await expect(loadDescriptorCatalog([descriptorPath])).rejects.toThrowError(AppError);
  });
});
