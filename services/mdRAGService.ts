import { createClient, SupabaseClient } from '@supabase/supabase-js';

type DocType = 'world_state' | 'agents' | 'bootstrap' | 'task';

export class MDRAGService {
  private supabase: SupabaseClient;

  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_KEY!
    );
  }

  /**
   * Upload or update an MD document with its embedding.
   * Call this when you update agents.md or other directive documents.
   */
  async upsertDocument(
    filename: string,
    docType: DocType,
    content: string,
    embedding: number[]
  ) {
    const { data: existingRows, error: existingError } = await this.supabase
      .from('md_documents')
      .select('id')
      .eq('filename', filename)
      .eq('doc_type', docType)
      .limit(1);

    if (existingError) throw new Error(`Failed to check for existing document: ${existingError.message}`);

    const payload = {
      filename,
      doc_type: docType,
      content,
      embedding,
      updated_at: new Date().toISOString(),
    };

    if (existingRows && existingRows.length > 0) {
      const { data, error } = await this.supabase
        .from('md_documents')
        .update(payload)
        .eq('id', existingRows[0].id)
        .select()
        .single();

      if (error) throw new Error(`Failed to update document: ${error.message}`);
      return data;
    }

    const { data, error } = await this.supabase
      .from('md_documents')
      .insert(payload)
      .select()
      .single();

    if (error) throw new Error(`Failed to upsert document: ${error.message}`);
    return data;
  }

  /**
   * Query MD documents by semantic similarity.
   */
  async queryMDDocuments(
    query: string,
    docType: DocType,
    limit: number = 3
  ): Promise<{ filename: string; content: string; similarity: number }[]> {
    // Embed the query with the same model used during document ingestion.
    const queryEmbedding = await this.embedText(query);

    const { data, error } = await this.supabase.rpc('match_md_documents', {
      query_embedding: queryEmbedding,
      doc_type: docType,
      match_count: limit,
    });

    if (error) throw new Error(`Failed to query documents: ${error.message}`);

    return data || [];
  }

  /**
   * Get all documents of a specific type (useful for auditing directives).
   */
  async getDocumentsByType(docType: DocType) {
    const { data, error } = await this.supabase
      .from('md_documents')
      .select('*')
      .eq('doc_type', docType)
      .order('updated_at', { ascending: false });

    if (error) throw new Error(`Failed to get documents: ${error.message}`);
    return data;
  }

  /**
   * Delete a document if a directive file is removed.
   */
  async deleteDocument(filename: string) {
    const { error } = await this.supabase
      .from('md_documents')
      .delete()
      .eq('filename', filename);

    if (error) throw new Error(`Failed to delete document: ${error.message}`);
  }

  private async embedText(text: string): Promise<number[]> {
    return this.embedTextWithOpenAI(text);
  }

  /**
   * Embed text with OpenAI's `text-embedding-3-small` model.
   */
  async embedTextWithOpenAI(text: string): Promise<number[]> {
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

    const data = (await response.json()) as {
      data?: Array<{ embedding: number[] }>;
    };

    const embedding = data.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error('OpenAI embeddings response did not include an embedding');
    }

    return embedding;
  }
}
