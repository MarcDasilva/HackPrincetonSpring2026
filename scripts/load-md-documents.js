import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DOC_PATH = resolve(process.cwd(), 'docs/agents.md');

function printUsage() {
  console.log(`
Load a markdown directive file into Supabase RAG storage.

Usage:
  npm run load:md-docs
  npm run load:md-docs -- --dry-run
  npm run load:md-docs -- --file docs/agents.md --doc-type agents
`.trim());
}

function parseArgs(argv) {
  const options = {
    docPath: DEFAULT_DOC_PATH,
    docType: 'agents',
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--file') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --file');
      }
      options.docPath = resolve(process.cwd(), value);
      index += 1;
      continue;
    }

    if (arg === '--doc-type') {
      const value = argv[index + 1];
      if (value !== 'agents') {
        throw new Error(`Unsupported doc type: ${value ?? '(missing)'}. Expected "agents".`);
      }
      options.docType = value;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export async function loadMDDocuments(options) {
  const content = await readFile(options.docPath, 'utf8');

  if (!content.trim()) {
    throw new Error(`Document is empty: ${options.docPath}`);
  }

  const filename = basename(options.docPath);

  if (options.dryRun) {
    console.log(`Would load ${filename} (${options.docType})`);
    console.log(`Path: ${options.docPath}`);
    console.log(`Character count: ${content.length}`);
    return;
  }

  const embedding = await embedTextWithOpenAI(content);
  const row = await upsertDocument(filename, options.docType, content, embedding);

  console.log(`Upserted ${row.filename} (${row.doc_type}) into md_documents`);
  console.log(`Updated at: ${row.updated_at}`);
}

async function embedTextWithOpenAI(text) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to embed text with OpenAI: ${response.status} ${errorBody}`);
  }

  const data = await response.json();
  const embedding = data.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error('OpenAI embeddings response did not include an embedding');
  }

  return embedding;
}

async function upsertDocument(filename, docType, content, embedding) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_KEY');
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: existingRows, error: existingError } = await supabase
    .from('md_documents')
    .select('id')
    .eq('filename', filename)
    .eq('doc_type', docType)
    .limit(1);

  if (existingError) {
    throw new Error(`Failed to check for existing document: ${existingError.message}`);
  }

  const payload = {
    filename,
    doc_type: docType,
    content,
    embedding,
    updated_at: new Date().toISOString(),
  };

  if (existingRows && existingRows.length > 0) {
    const { data, error } = await supabase
      .from('md_documents')
      .update(payload)
      .eq('id', existingRows[0].id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update document: ${error.message}`);
    }

    return data;
  }

  const { data, error } = await supabase
    .from('md_documents')
    .insert(payload)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to upsert document: ${error.message}`);
  }

  return data;
}

const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : null;
const currentFilePath = fileURLToPath(import.meta.url);

if (entrypointPath === currentFilePath) {
  loadMDDocuments(parseArgs(process.argv.slice(2))).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
